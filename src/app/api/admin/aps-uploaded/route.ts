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
    const { lead_id, lead_type, lead_types } = body as {
      lead_id: string;
      lead_type?: string;       // single side: "Purchase" | "Sale"
      lead_types?: string[];    // multiple sides
    };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    // Normalize the requested lead_type(s). When omitted, completeApsTask
    // auto-detects from lead_corporate_docs (aps_purchase / aps_sale).
    const forLeadTypes = lead_types && lead_types.length > 0
      ? lead_types
      : lead_type
      ? [lead_type]
      : undefined;

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

    // 3. Complete the APS task across the family (only for the requested
    //    side(s); falls back to auto-detection from lead_corporate_docs).
    const result = await completeApsTask(deal.id, { forLeadTypes });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      already_completed: result.already_completed ?? false,
      completed_lead_types: result.completed_lead_types ?? [],
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
