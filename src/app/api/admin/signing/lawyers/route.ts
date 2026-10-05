import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { listLawyers } from "@/lib/signingConfig";

// GET /api/admin/signing/lawyers — list all lawyers (active and inactive).
// POST /api/admin/signing/lawyers — create a lawyer.
// Gated to admins by src/middleware.ts.

export async function GET() {
  const lawyers = await listLawyers();
  return NextResponse.json({ success: true, data: lawyers });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const initials = String(body.initials ?? "").trim().toUpperCase();
  const fullName = String(body.full_name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const calendarId = String(body.calendar_id ?? "primary").trim() || "primary";

  if (!initials || !fullName || !email) {
    return NextResponse.json(
      { success: false, error: "initials, full_name and email are required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from("signing_lawyers")
    .insert({
      initials,
      full_name: fullName,
      email,
      calendar_id: calendarId,
      is_active: body.is_active !== false,
    })
    .select("*")
    .single();

  if (error) {
    logger.error("[SigningLawyers POST] insert failed:", error.message);
    const status = error.code === "23505" ? 409 : 400;
    return NextResponse.json({ success: false, error: error.message }, { status });
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_lawyer.create",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_lawyer",
    resourceId: String(data.id),
    metadata: { initials, email },
    req,
  });

  return NextResponse.json({ success: true, data });
}
