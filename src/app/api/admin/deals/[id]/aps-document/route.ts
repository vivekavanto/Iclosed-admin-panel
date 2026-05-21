import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

/**
 * DELETE /api/admin/deals/[id]/aps-document
 *
 * Family-wide tear-down of the APS document. Removes the APS row(s) from
 * lead_corporate_docs and the bridged file rows from task_responses on every
 * APS task in the deal's co-purchaser/co-seller family.
 *
 * This is the inverse of POST /uploadblobstorage and is what the Edit Task
 * modal calls when the admin trashes the APS file — without it, the doc
 * survives in lead_corporate_docs and the next upload's preflight still
 * warns that an APS already exists.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    const familyDealIds = await getFamilyDealIds(dealId);

    // 1. Delete bridged task_responses for every APS task in the family.
    const { data: apsTemplates } = await supabaseAdmin
      .from("task_templates")
      .select("id")
      .eq("is_aps_task", true)
      .eq("is_deleted", false);
    const apsTemplateIds = (apsTemplates ?? []).map((t) => t.id);

    if (apsTemplateIds.length > 0) {
      const { data: apsTasks } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .in("deal_id", familyDealIds)
        .in("task_template_id", apsTemplateIds);
      const apsTaskIds = (apsTasks ?? []).map((t) => t.id);

      if (apsTaskIds.length > 0) {
        await supabaseAdmin
          .from("task_responses")
          .delete()
          .in("task_id", apsTaskIds)
          .eq("field_type", "file");
      }
    }

    // 2. Delete APS rows from lead_corporate_docs for every family lead.
    const { data: familyDeals } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .in("id", familyDealIds);
    const familyLeadIds = [
      ...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean)),
    ];

    if (familyLeadIds.length > 0) {
      await supabaseAdmin
        .from("lead_corporate_docs")
        .delete()
        .in("lead_id", familyLeadIds)
        .or(
          "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%",
        );
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error("DELETE /api/admin/deals/[id]/aps-document error:", err);
    return NextResponse.json(
      { success: false, error: err?.message ?? "Server error" },
      { status: 500 },
    );
  }
}
