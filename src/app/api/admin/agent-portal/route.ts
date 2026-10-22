import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";

// GET /api/admin/agent-portal — partners to preview the agent portal as.
// Admin-only test harness until agents get their own login.
export async function GET() {
  const { data, error } = await supabaseAdmin
    .from("partners")
    .select("id, agent_name, agent_email, brokerage_type, brokerage_name, referral_code")
    .eq("is_deleted", false)
    .order("agent_name", { ascending: true });
  if (error) {
    logger.error("[agent-portal] partner list failed:", error);
    return NextResponse.json({ success: false, error: "Could not load partners" }, { status: 500 });
  }
  return NextResponse.json({ success: true, partners: data ?? [] });
}
