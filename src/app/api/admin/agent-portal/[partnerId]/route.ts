import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { loadAgentFiles, loadAgentPortalPartner, torontoToday } from "@/lib/agentPortalData";

// GET /api/admin/agent-portal/[partnerId] — the agent's dashboard: every
// referred file with clubbed milestones/tasks, split by Purchase / Sale.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  if (!isUuid(partnerId)) return NextResponse.json({ success: false, error: "Invalid partner id" }, { status: 400 });

  try {
    const partner = await loadAgentPortalPartner(partnerId);
    if (!partner) return NextResponse.json({ success: false, error: "Partner not found" }, { status: 404 });
    const files = await loadAgentFiles(partnerId);
    return NextResponse.json({ success: true, partner, files, today: torontoToday() });
  } catch (err) {
    logger.error("[agent-portal] dashboard load failed:", err);
    return NextResponse.json({ success: false, error: "Could not load the agent's files" }, { status: 500 });
  }
}
