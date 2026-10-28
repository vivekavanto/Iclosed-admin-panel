import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { verifyStaffIntakeToken } from "@/lib/staffIntakeToken";
import { sendRetainerLinkEmail } from "@/lib/sendRetainerLink";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_LEAD_AGE_MS = 60 * 60 * 1000;

// Intake filled by staff or a partner-portal agent: email the retainer instead of the quote.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "staff-intake-retainer" });
    if (blocked) return blocked;

    const body = JSON.parse(raw) as { token?: string; lead_ids?: unknown };
    if (!verifyStaffIntakeToken(body.token)) {
      return NextResponse.json({ success: false, error: "Invalid staff intake token" }, { status: 401 });
    }
    const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids.filter(isUuid).slice(0, 10) : [];
    if (leadIds.length === 0) {
      return NextResponse.json({ success: false, error: "lead_ids is required" }, { status: 400 });
    }

    const { data: leads, error } = await supabaseAdmin
      .from("leads")
      .select("id, email, parent_lead_id, intake_source, created_at")
      .in("id", leadIds);
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    // Only fresh staff/agent intakes, so a leaked token can't mail retainers to arbitrary leads.
    const eligible = (leads ?? []).filter(
      (l) =>
        (l.intake_source === "staff" || l.intake_source === "agent") &&
        l.email &&
        Date.now() - new Date(l.created_at).getTime() < MAX_LEAD_AGE_MS,
    );

    const results = await Promise.all(
      eligible.map(async (l) => {
        const res = await sendRetainerLinkEmail({
          email: l.email,
          leadId: l.id,
          side: null,
          primaryLeadId: l.parent_lead_id ?? l.id,
        });
        if (!res.success) logger.error(`[staff-intake-retainer] lead=${l.id} ${res.error}`);
        return { lead_id: l.id, sent: res.success, error: res.error };
      }),
    );

    const sent = results.filter((r) => r.sent).length;
    return NextResponse.json({
      success: sent > 0,
      results,
      ...(sent === 0 ? { error: "No retainer email was sent" } : {}),
    });
  } catch (err: unknown) {
    logger.error("POST /api/webhooks/staff-intake-retainer error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
