import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

/**
 * GET /api/admin/deals/[id]/aps-status
 *
 * Preflight for the admin APS upload modal. Returns whether APS documents
 * already exist anywhere in the deal's co-purchaser/co-seller family, plus
 * how many and their file names, so the modal can show an informational
 * "N file(s) already uploaded — new files will be added" notice before the
 * admin submits. (Uploads append; they do not replace.)
 *
 * Response: { uploaded: boolean, count: number, file_names: string[] }
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    // Optional side scoping ("purchase" | "sale"). When provided, only that
    // side's APS counts as "already uploaded" so a Purchase & Sale deal can
    // warn-per-side instead of treating the whole family as one APS.
    const rawSide = new URL(_req.url).searchParams.get("side")?.toLowerCase().trim();
    const side: "purchase" | "sale" | null =
      rawSide === "purchase" || rawSide === "sale" ? rawSide : null;

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
      // A side-scoped check matches that side's APS row plus the generic
      // "aps" rows (which by definition span both sides).
      const orPredicate = side === "purchase"
        ? "doc_type.eq.aps,doc_type.eq.aps_purchase,custom_type.ilike.%APS purchase%"
        : side === "sale"
        ? "doc_type.eq.aps,doc_type.eq.aps_sale,custom_type.ilike.%APS sale%"
        : "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%";
      const { data: existingDocs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("file_name")
        .in("lead_id", familyLeadIds)
        .or(orPredicate);
      if (existingDocs && existingDocs.length > 0) {
        return NextResponse.json({
          uploaded: true,
          count: existingDocs.length,
          file_names: existingDocs.map((d) => d.file_name).filter(Boolean),
        });
      }
    }

    // 2. Fallback: a bridged task_response with a file_url on an APS task.
    let apsTemplatesQuery = supabaseAdmin
      .from("task_templates")
      .select("id, lead_type")
      .eq("is_aps_task", true)
      .eq("is_deleted", false);
    if (side) {
      // task_templates.lead_type is stored capitalized ("Purchase" / "Sale").
      apsTemplatesQuery = apsTemplatesQuery.eq("lead_type", side === "purchase" ? "Purchase" : "Sale");
    }
    const { data: apsTemplates } = await apsTemplatesQuery;
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
          .not("file_url", "is", null);
        if (existingResponses && existingResponses.length > 0) {
          return NextResponse.json({
            uploaded: true,
            count: existingResponses.length,
            file_names: existingResponses.map((r) => r.file_name).filter(Boolean),
          });
        }
      }
    }

    return NextResponse.json({ uploaded: false, count: 0, file_names: [] });
  } catch (err: any) {
    console.error("GET /api/admin/deals/[id]/aps-status error:", err);
    return NextResponse.json(
      { uploaded: false, count: 0, file_names: [], error: err?.message ?? "Server error" },
      { status: 500 },
    );
  }
}
