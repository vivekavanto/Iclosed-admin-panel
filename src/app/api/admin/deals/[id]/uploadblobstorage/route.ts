import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { completeApsTask } from "@/lib/completeApsTask";
import { getFamilyDealIds } from "@/lib/familyDeals";

/**
 * POST /api/admin/deals/[id]/uploadblobstorage
 *
 * Finalize endpoint for the admin APS upload. The file bytes are uploaded
 * directly from the admin browser to Vercel Blob via @vercel/blob/client
 * (token issued by /uploadblobstorage/token); this endpoint then takes the
 * resulting blob URL, records it in `lead_corporate_docs`, and delegates
 * to `completeApsTask`, which:
 *   - bridges the doc into `task_responses` for every APS task on the deal
 *   - marks the APS task(s) Completed
 *   - syncs completion across all linked co-purchaser/co-seller deals
 *   - recalculates milestones for the entire family
 *
 * If an APS document already exists anywhere in the family, the admin
 * upload REPLACES it: prior `lead_corporate_docs` APS rows and
 * `task_responses` file rows for family APS tasks are deleted before the
 * new doc is inserted. (Customer-side uploads still go through a separate
 * flow with the existing already-uploaded guard.)
 *
 * Body (JSON): { file_url: string, file_name: string }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    // ── 1. Parse + validate body ─────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    const fileUrl = body?.file_url;
    const fileName = body?.file_name;

    if (!fileUrl || typeof fileUrl !== "string") {
      return NextResponse.json(
        { success: false, error: "file_url is required" },
        { status: 400 },
      );
    }
    if (!fileName || typeof fileName !== "string") {
      return NextResponse.json(
        { success: false, error: "file_name is required" },
        { status: 400 },
      );
    }

    // Defense in depth: only accept Vercel Blob URLs so a caller can't
    // smuggle arbitrary URLs into lead_corporate_docs.
    let host: string;
    try {
      host = new URL(fileUrl).hostname;
    } catch {
      return NextResponse.json(
        { success: false, error: "file_url is not a valid URL" },
        { status: 400 },
      );
    }
    if (!host.endsWith(".public.blob.vercel-storage.com")) {
      return NextResponse.json(
        { success: false, error: "file_url must be a Vercel Blob URL" },
        { status: 400 },
      );
    }

    // ── 2. Resolve deal → lead ───────────────────────────────────────────────
    const { data: deal, error: dealError } = await supabaseAdmin
      .from("deals")
      .select("id, lead_id")
      .eq("id", dealId)
      .maybeSingle();

    if (dealError) {
      return NextResponse.json(
        { success: false, error: dealError.message },
        { status: 500 },
      );
    }
    if (!deal) {
      return NextResponse.json(
        { success: false, error: "Deal not found" },
        { status: 404 },
      );
    }
    if (!deal.lead_id) {
      return NextResponse.json(
        {
          success: false,
          error:
            "This deal has no linked lead yet (bulk-imported). Convert the lead before uploading an APS.",
        },
        { status: 400 },
      );
    }

    // ── 3. Clear any prior APS doc + task_responses across the family ───────
    // Admin upload replaces an existing APS — wipe family-wide rows so the
    // doc bridging in completeApsTask binds the new file to every APS task.
    const familyDealIds = await getFamilyDealIds(dealId);

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

    // ── 4. Insert into lead_corporate_docs ───────────────────────────────────
    // doc_type = "aps" is the generic value: completeApsTask's bridging treats
    // it as applying to all APS task lead_types (Purchase + Sale).
    const { error: docError } = await supabaseAdmin
      .from("lead_corporate_docs")
      .insert({
        lead_id: deal.lead_id,
        doc_type: "aps",
        custom_type: "APS Document",
        file_url: fileUrl,
        file_name: fileName,
      });

    if (docError) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to record document: ${docError.message}`,
        },
        { status: 500 },
      );
    }

    // ── 5. Complete the APS task across the family ───────────────────────────
    const result = await completeApsTask(dealId);

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Task completion failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      file_url: fileUrl,
      file_name: fileName,
      already_completed: result.already_completed ?? false,
      completed_lead_types: result.completed_lead_types ?? [],
    });
  } catch (err: any) {
    console.error("POST /api/admin/deals/[id]/uploadblobstorage error:", err);
    return NextResponse.json(
      { success: false, error: err.message ?? "Server error" },
      { status: 500 },
    );
  }
}
