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
    // Optional side scoping: "purchase" or "sale". When provided, the
    // upload only affects that side's APS row + tasks across the family,
    // so a Purchase-side APS upload on a P&S deal doesn't leak into
    // the Sale-side APS task. Omitting it falls back to the legacy
    // generic-aps behaviour (applies to both sides).
    const rawSide = typeof body?.side === "string" ? body.side.toLowerCase().trim() : null;
    const side: "purchase" | "sale" | null =
      rawSide === "purchase" || rawSide === "sale" ? rawSide : null;

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
    // When `side` is specified, the wipe is restricted to that side so a
    // Purchase upload doesn't accidentally clear the family's Sale APS.
    const familyDealIds = await getFamilyDealIds(dealId);

    // Resolve APS templates, optionally scoped to one lead_type.
    let apsTemplatesQuery = supabaseAdmin
      .from("task_templates")
      .select("id, lead_type")
      .eq("is_aps_task", true)
      .eq("is_deleted", false);
    if (side) {
      // task_templates.lead_type is stored capitalized ("Purchase" / "Sale")
      const lt = side === "purchase" ? "Purchase" : "Sale";
      apsTemplatesQuery = apsTemplatesQuery.eq("lead_type", lt);
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
      // Build the predicate so a side-scoped upload only deletes its
      // matching APS row (plus the generic "aps" / legacy custom_type
      // rows, which by definition span both sides).
      const orPredicate = side === "purchase"
        ? "doc_type.eq.aps,doc_type.eq.aps_purchase,custom_type.ilike.%APS purchase%"
        : side === "sale"
        ? "doc_type.eq.aps,doc_type.eq.aps_sale,custom_type.ilike.%APS sale%"
        : "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%";
      await supabaseAdmin
        .from("lead_corporate_docs")
        .delete()
        .in("lead_id", familyLeadIds)
        .or(orPredicate);
    }

    // ── 4. Insert into lead_corporate_docs ───────────────────────────────────
    // doc_type tells the bridge in completeApsTask which APS task(s) to
    // attach this to:
    //   "aps_purchase" → Purchase-side APS task only
    //   "aps_sale"     → Sale-side APS task only
    //   "aps"          → both sides (legacy / when side isn't known)
    const docType = side === "purchase"
      ? "aps_purchase"
      : side === "sale"
      ? "aps_sale"
      : "aps";
    const customType = side === "purchase"
      ? "APS Purchase Document"
      : side === "sale"
      ? "APS Sale Document"
      : "APS Document";
    const { error: docError } = await supabaseAdmin
      .from("lead_corporate_docs")
      .insert({
        lead_id: deal.lead_id,
        doc_type: docType,
        custom_type: customType,
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
    // Pass the explicit side so completeApsTask only completes + bridges
    // the matching lead_type's APS task, not the other side.
    const result = await completeApsTask(dealId, {
      forLeadTypes: side === "purchase"
        ? ["Purchase"]
        : side === "sale"
        ? ["Sale"]
        : undefined,
    });

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
