import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { isUuid } from "@/lib/isUuid";
import { getLawyerHours } from "@/lib/signingConfig";

// GET /api/admin/signing/lawyers/[id]/hours — weekly working-hours template.
// PUT /api/admin/signing/lawyers/[id]/hours — replace the whole week in one call.
//   Body: { hours: [{ day_of_week, start_time, end_time }, ...] } — one entry
//   per working day; a day with no entry has no availability at all that day.
// Gated to admins by src/middleware.ts.

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

interface HourInput {
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  const hours = await getLawyerHours(id);
  return NextResponse.json({ success: true, data: hours });
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  let body: { hours?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.hours)) {
    return NextResponse.json({ success: false, error: "hours must be an array" }, { status: 400 });
  }

  const rows: HourInput[] = [];
  for (const entry of body.hours) {
    const e = entry as Partial<HourInput>;
    const day = Number(e.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      return NextResponse.json({ success: false, error: "day_of_week must be 0-6" }, { status: 400 });
    }
    if (typeof e.start_time !== "string" || !TIME_RE.test(e.start_time)) {
      return NextResponse.json({ success: false, error: `Invalid start_time for day ${day}` }, { status: 400 });
    }
    if (typeof e.end_time !== "string" || !TIME_RE.test(e.end_time)) {
      return NextResponse.json({ success: false, error: `Invalid end_time for day ${day}` }, { status: 400 });
    }
    if (e.end_time <= e.start_time) {
      return NextResponse.json({ success: false, error: `end_time must be after start_time for day ${day}` }, { status: 400 });
    }
    rows.push({ day_of_week: day, start_time: e.start_time, end_time: e.end_time });
  }

  // Replace-the-week: delete existing rows for this lawyer, then insert the
  // supplied set. Simpler and safer than a diff — the admin UI always submits
  // the full week.
  const { error: delError } = await supabaseAdmin
    .from("signing_lawyer_hours")
    .delete()
    .eq("lawyer_id", id);
  if (delError) {
    logger.error("[SigningLawyerHours PUT] delete failed:", delError.message);
    return NextResponse.json({ success: false, error: delError.message }, { status: 400 });
  }

  let inserted: unknown[] = [];
  if (rows.length > 0) {
    const { data, error } = await supabaseAdmin
      .from("signing_lawyer_hours")
      .insert(rows.map((r) => ({ ...r, lawyer_id: id })))
      .select("*");
    if (error) {
      logger.error("[SigningLawyerHours PUT] insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
    inserted = data ?? [];
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "signing_lawyer_hours.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "signing_lawyer",
    resourceId: id,
    metadata: { day_count: rows.length },
    req,
  });

  return NextResponse.json({ success: true, data: inserted });
}
