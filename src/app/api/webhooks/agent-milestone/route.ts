import { NextRequest, NextResponse, after } from "next/server";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { notifyAgentMilestone } from "@/lib/notifyAgentMilestone";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

// POST { milestone_id } — the portal calls this when a client completes a milestone,
// so agents who opted into it get an email. Server-to-server only, no CORS.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "agent-milestone" });
    if (blocked) return blocked;

    const body = JSON.parse(raw) as { milestone_id?: string };
    if (!isUuid(body.milestone_id)) {
      return NextResponse.json({ success: false, error: "milestone_id (uuid) is required" }, { status: 400 });
    }
    const milestoneId = body.milestone_id as string;

    // Acknowledge first, send after, so the client's submission isn't held up.
    after(async () => {
      const result = await notifyAgentMilestone(milestoneId);
      logger.info(`[agent-milestone] milestone=${milestoneId} sent=${result.sent.length}${result.reason ? ` reason=${result.reason}` : ""}`);
    });
    return NextResponse.json({ success: true, accepted: true });
  } catch (err: unknown) {
    logger.error("POST /api/webhooks/agent-milestone error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
