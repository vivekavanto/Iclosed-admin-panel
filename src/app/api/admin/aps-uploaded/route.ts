import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { completeApsTask } from "@/lib/completeApsTask";

/**
 * POST /api/admin/aps-uploaded
 *
 * Sets `aps_uploaded = true` on a lead, then auto-completes the APS shared
 * task and recalculates milestones for the entire co-purchaser family.
 *
 * Body: { lead_id: string }
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id } = body as { lead_id: string };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    // 1. Set aps_uploaded = true on the lead
    const { error: updateError } = await supabaseAdmin
      .from("leads")
      .update({ aps_uploaded: true })
      .eq("id", lead_id);

    if (updateError) {
      return NextResponse.json(
        { success: false, error: `Failed to update lead: ${updateError.message}` },
        { status: 500 },
      );
    }

    // 2. Find the deal for this lead
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id")
      .eq("lead_id", lead_id)
      .maybeSingle();

    if (!deal) {
      // Lead not yet converted — flag is stored, will be picked up at conversion time
      return NextResponse.json({
        success: true,
        message: "aps_uploaded set. Deal not yet created — task will be completed on conversion.",
      });
    }

    // 3. Complete the APS task across the family
    const result = await completeApsTask(deal.id);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      already_completed: result.already_completed ?? false,
      message: result.already_completed
        ? "APS task was already completed"
        : "APS task completed and milestones updated for all linked deals",
    });
  } catch (err: any) {
    console.error("POST /api/admin/aps-uploaded error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Server error" },
      { status: 500 },
    );
  }
}
