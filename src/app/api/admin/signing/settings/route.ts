import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getSettings } from "@/lib/signingConfig";
import { EMAIL_PATTERN, parseEmailList } from "@/lib/signingEmailList";

// GET /api/admin/signing/settings — the single signing_settings row.
// PUT /api/admin/signing/settings — update it (creates the row if the
// migration's seed was skipped on this environment).
// Gated to admins by src/middleware.ts.

const EDITABLE_FIELDS = [
  "default_duration_minutes",
  "buffer_minutes",
  "slot_increment_minutes",
  "office_address",
  "clerk_email",
  "optional_guest_email",
  "disclaimer_text",
  "default_signing_with",
  "min_business_days_before_closing",
  "max_business_days_before_closing",
] as const;

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json({ success: true, data: settings });
}

export async function PUT(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  for (const field of EDITABLE_FIELDS) {
    if (body[field] === undefined) continue;
    updates[field] = body[field];
  }

  for (const numField of ["default_duration_minutes", "buffer_minutes", "slot_increment_minutes"] as const) {
    if (updates[numField] !== undefined) {
      const n = Number(updates[numField]);
      // Buffer may be 0 (no turnaround gap); duration and increment may not.
      const min = numField === "buffer_minutes" ? 0 : 1;
      if (!Number.isInteger(n) || n < min) {
        return NextResponse.json(
          { success: false, error: `${numField} must be ${min === 0 ? "zero or a positive" : "a positive"} integer` },
          { status: 400 },
        );
      }
      updates[numField] = n;
    }
  }

  if (updates.min_business_days_before_closing !== undefined) {
    const n = Number(updates.min_business_days_before_closing);
    if (!Number.isInteger(n) || n < 0 || n > 30) {
      return NextResponse.json(
        { success: false, error: "min_business_days_before_closing must be a whole number from 0 to 30" },
        { status: 400 },
      );
    }
    updates.min_business_days_before_closing = n;
  }

  if (updates.max_business_days_before_closing !== undefined) {
    const n = Number(updates.max_business_days_before_closing);
    if (!Number.isInteger(n) || n < 0 || n > 30) {
      return NextResponse.json(
        { success: false, error: "max_business_days_before_closing must be a whole number from 0 to 30" },
        { status: 400 },
      );
    }
    updates.max_business_days_before_closing = n;
  }

  // The window is [closing - max, closing - min]; max below min would be empty.
  if (
    updates.min_business_days_before_closing !== undefined ||
    updates.max_business_days_before_closing !== undefined
  ) {
    const current = await getSettings();
    const min = Number(updates.min_business_days_before_closing ?? current.min_business_days_before_closing);
    const max = Number(updates.max_business_days_before_closing ?? current.max_business_days_before_closing);
    if (max > 0 && max < min) {
      return NextResponse.json(
        { success: false, error: "\"No earlier than\" days must be at least the \"Book at least\" days (or 0 for no limit)" },
        { status: 400 },
      );
    }
  }

  // clerk_email holds the whole CC list, comma-separated. Every address must be
  // a plain email. reception_email is blanked so the list is never stored twice
  // (getSettings folds old reception addresses into clerk_email on read).
  if (updates.clerk_email !== undefined) {
    const list = parseEmailList(String(updates.clerk_email ?? ""));
    const invalid = list.filter((e) => !EMAIL_PATTERN.test(e));
    if (invalid.length > 0) {
      return NextResponse.json(
        { success: false, error: `Not a valid CC email: ${invalid.join(", ")}` },
        { status: 400 },
      );
    }
    updates.clerk_email = list.join(", ");
    updates.reception_email = "";
  }

  // Blank clears the optional guest; anything else must be a plain email.
  if (updates.optional_guest_email !== undefined) {
    const v = String(updates.optional_guest_email ?? "").trim();
    if (v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      return NextResponse.json(
        { success: false, error: "Optional guest must be a valid email address" },
        { status: 400 },
      );
    }
    updates.optional_guest_email = v;
  }

  // A blank default clears it (stored as NULL), never as "".
  if (updates.default_signing_with !== undefined) {
    const v = String(updates.default_signing_with ?? "").trim();
    updates.default_signing_with = v || null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ success: false, error: "No editable fields supplied" }, { status: 400 });
  }
  updates.updated_at = new Date().toISOString();

  const { data: existing, error: readError } = await supabaseAdmin
    .from("signing_settings")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (readError) {
    logger.error("[SigningSettings PUT] read failed:", readError.message);
    return NextResponse.json({ success: false, error: readError.message }, { status: 400 });
  }

  let saved: Record<string, unknown> | null = null;
  if (existing?.id) {
    const { data, error } = await supabaseAdmin
      .from("signing_settings")
      .update(updates)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      logger.error("[SigningSettings PUT] update failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data;
  } else {
    const { data, error } = await supabaseAdmin
      .from("signing_settings")
      .insert(updates)
      .select("*")
      .single();
    if (error) {
      logger.error("[SigningSettings PUT] insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    saved = data;
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_settings.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_settings",
    resourceId: String(saved?.id ?? ""),
    metadata: { changed: Object.keys(updates).filter((k) => k !== "updated_at") },
    req,
  });

  return NextResponse.json({ success: true, data: saved });
}
