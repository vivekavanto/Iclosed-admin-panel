import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { getFamilyDealIds } from "@/lib/familyDeals";
import {
  FINAL_REPORT_LEAD_COLUMNS,
  sendFinalReportEmail,
} from "@/lib/sendFinalReportEmail";

// POST /api/admin/deals/[id]/final-report/email
//
// Sends the final reporting package to the client(s). One email per recipient
// so the template's {{ user.first_name }} names the person reading it, with the
// documents scoped to the side that person is party to.
//
// Body (optional): { lead_ids: string[] } to send to a subset. Omit it and
// everyone on the file with an email address receives their copy.
//
// Gated to admins by src/middleware.ts.

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  // Outward-facing, carries attachments, and a double-click must not double-send.
  if (!(await rateLimitOk(`final-report:${id}`, 5, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is legitimate: send to everyone on the file.
  }

  const leadIds = Array.isArray(body.lead_ids)
    ? (body.lead_ids as unknown[]).filter(
        (v): v is string => typeof v === "string" && isUuid(v),
      )
    : [];

  const familyDealIds = await getFamilyDealIds(id);
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .in("id", familyDealIds)
    .eq("is_deleted", false);

  const familyLeadIds = [
    ...new Set((deals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
  ];
  if (familyLeadIds.length === 0) {
    return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
  }

  const { data: leads, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select(FINAL_REPORT_LEAD_COLUMNS)
    .in("id", familyLeadIds)
    .eq("is_deleted", false);

  if (leadErr) {
    logger.error("[FinalReport email] lead read failed:", leadErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the clients on this file" },
      { status: 500 },
    );
  }

  const result = await sendFinalReportEmail({
    leads: leads ?? [],
    dealId: id,
    recipientLeadIds: leadIds,
  });

  // A hard stop — no template, no document, nobody to send to.
  if (result.error) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "final_report.email",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "deals",
    resourceId: id,
    metadata: {
      sent_to: result.sent.map((s) => s.email),
      failed: result.failed.map((f) => f.email),
    },
    req,
  });

  // Partial success is reported as success with the failures listed — some
  // clients did receive their package, and reporting a flat failure would
  // invite a re-send that double-mails them.
  return NextResponse.json({
    success: result.sent.length > 0,
    sent: result.sent,
    failed: result.failed,
    error:
      result.sent.length === 0
        ? (result.failed[0]?.error ?? "Could not send the final report")
        : undefined,
  });
}
