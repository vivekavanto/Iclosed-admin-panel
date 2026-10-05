import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getSettings } from "@/lib/signingConfig";

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
  "reception_email",
  "disclaimer_text",
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
      if (!Number.isInteger(n) || n <= 0) {
        return NextResponse.json({ success: false, error: `${numField} must be a positive integer` }, { status: 400 });
      }
      updates[numField] = n;
    }
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
