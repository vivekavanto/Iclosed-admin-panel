import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

/**
 * DELETE /api/admin/deals/[id]/aps-document
 *
 * Tear-down of APS document(s) across the deal's co-purchaser/co-seller
 * family. Removes the APS row(s) from lead_corporate_docs AND the bridged
 * file rows from task_responses on every APS task in the family.
 *
 * Two modes:
 *   - No `file_url` query param → "remove all": wipes every APS file.
 *   - `?file_url=…`             → "remove one": wipes only the file with that
 *                                  exact blob URL (used by the per-file trash
 *                                  button now that uploads append).
 *
 * Deleting BOTH the lead_corporate_docs row and the task_responses row is
 * mandatory: completeApsTask re-bridges task_responses from
 * lead_corporate_docs, so leaving the source row would resurrect the file.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    // Optional single-file scope. When present, only the file with this exact
    // blob URL is removed; otherwise every APS file in the family is removed.
    const fileUrl = new URL(req.url).searchParams.get("file_url")?.trim() || null;

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
        let respDelete = supabaseAdmin
          .from("task_responses")
          .delete()
          .in("task_id", apsTaskIds)
          .eq("field_type", "file");
        if (fileUrl) respDelete = respDelete.eq("file_url", fileUrl);
        await respDelete;
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
      // Two passes instead of one `.or(doc_type.eq.…,custom_type.ilike.…)`: an
      // OR filter on a DELETE fails on the production Supabase project with
      // `42703: column lead_corporate_docs.doc_type does not exist` (older
      // PostgREST than dev), so in prod this deleted nothing — and the result
      // was never checked, so it failed silently. OR filters are read-only.
      const passes = [
        (q: ReturnType<typeof buildDocDelete>) =>
          q.in("doc_type", ["aps", "aps_purchase", "aps_sale"]),
        (q: ReturnType<typeof buildDocDelete>) => q.ilike("custom_type", "%APS%"),
      ];

      function buildDocDelete() {
        const q = supabaseAdmin
          .from("lead_corporate_docs")
          .delete()
          .in("lead_id", familyLeadIds);
        return fileUrl ? q.eq("file_url", fileUrl) : q;
      }

      for (const applyFilter of passes) {
        const { error: deleteError } = await applyFilter(buildDocDelete());
        if (deleteError) {
          console.warn(
            `[aps-document DELETE] failed to clear APS docs: ${deleteError.message}`,
          );
        }
      }
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
