import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

/**
 * GET /api/admin/deals/[id]/aps-status
 *
 * Preflight for the admin APS upload modal. Returns whether an APS document
 * already exists anywhere in the deal's co-purchaser/co-seller family, plus
 * the existing file name (if any) so the modal can show a "this will
 * replace …" warning before the admin submits.
 *
 * Response: { uploaded: boolean, file_name?: string }
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    const familyDealIds = await getFamilyDealIds(dealId);

    // 1. Check lead_corporate_docs for an APS row anywhere in the family.
    const { data: familyDeals } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .in("id", familyDealIds);
    const familyLeadIds = [
      ...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean)),
    ];

    if (familyLeadIds.length > 0) {
      const { data: existingDocs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("file_name")
        .in("lead_id", familyLeadIds)
        .or(
          "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%",
        )
        .limit(1);
      if (existingDocs && existingDocs.length > 0) {
        return NextResponse.json({
          uploaded: true,
          file_name: existingDocs[0].file_name ?? undefined,
        });
      }
    }

    // 2. Fallback: a bridged task_response with a file_url on an APS task.
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
        const { data: existingResponses } = await supabaseAdmin
          .from("task_responses")
          .select("file_name")
          .in("task_id", apsTaskIds)
          .eq("field_type", "file")
          .not("file_url", "is", null)
          .limit(1);
        if (existingResponses && existingResponses.length > 0) {
          return NextResponse.json({
            uploaded: true,
            file_name: existingResponses[0].file_name ?? undefined,
          });
        }
      }
    }

    return NextResponse.json({ uploaded: false });
  } catch (err: any) {
    console.error("GET /api/admin/deals/[id]/aps-status error:", err);
    return NextResponse.json(
      { uploaded: false, error: err?.message ?? "Server error" },
      { status: 500 },
    );
  }
}
