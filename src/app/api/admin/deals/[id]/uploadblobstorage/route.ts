import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { completeApsTask } from "@/lib/completeApsTask";

/**
 * POST /api/admin/deals/[id]/uploadblobstorage
 *
 * Finalize endpoint for the admin APS upload. The file bytes are uploaded
 * directly from the admin browser to Vercel Blob via @vercel/blob/client
 * (token issued by /uploadblobstorage/token); this endpoint then takes the
 * resulting blob URL(s), records them in `lead_corporate_docs`, and
 * delegates to `completeApsTask`, which:
 *   - bridges the doc(s) into `task_responses` for every APS task on the deal
 *   - marks the APS task(s) Completed
 *   - syncs completion across all linked co-purchaser/co-seller deals
 *   - recalculates milestones for the entire family
 *
 * Uploads APPEND: existing APS documents are kept and the new file(s) are
 * added alongside them, so a deal can hold the agreement plus its
 * amendments/waivers. (Removing an individual file is handled by
 * DELETE /aps-document?file_url=…) The bridge in completeApsTask reconciles
 * `task_responses` against the full set of APS rows in `lead_corporate_docs`,
 * so previously-uploaded files stay attached.
 *
 * Body (JSON), either form is accepted:
 *   - legacy single: { file_url: string, file_name: string, side?: string }
 *   - batch:         { files: [{ file_url: string, file_name: string }], side?: string }
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    // ── 1. Parse + validate body ─────────────────────────────────────────────
    const body = await req.json().catch(() => null);
    // Optional side scoping: "purchase" or "sale". When provided, the
    // upload only affects that side's APS row + tasks across the family,
    // so a Purchase-side APS upload on a P&S deal doesn't leak into
    // the Sale-side APS task. Omitting it falls back to the legacy
    // generic-aps behaviour (applies to both sides).
    const rawSide = typeof body?.side === "string" ? body.side.toLowerCase().trim() : null;
    const side: "purchase" | "sale" | null =
      rawSide === "purchase" || rawSide === "sale" ? rawSide : null;

    // Normalize to a files[] array. Accept either the legacy single
    // { file_url, file_name } shape or a batch { files: [...] }.
    const rawFiles: any[] = Array.isArray(body?.files) && body.files.length > 0
      ? body.files
      : body?.file_url || body?.file_name
      ? [{ file_url: body?.file_url, file_name: body?.file_name }]
      : [];

    if (rawFiles.length === 0) {
      return NextResponse.json(
        { success: false, error: "At least one file (file_url + file_name) is required" },
        { status: 400 },
      );
    }

    const files: { file_url: string; file_name: string }[] = [];
    for (const f of rawFiles) {
      const fileUrl = f?.file_url;
      const fileName = f?.file_name;
      if (!fileUrl || typeof fileUrl !== "string") {
        return NextResponse.json(
          { success: false, error: "file_url is required for every file" },
          { status: 400 },
        );
      }
      if (!fileName || typeof fileName !== "string") {
        return NextResponse.json(
          { success: false, error: "file_name is required for every file" },
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
      files.push({ file_url: fileUrl, file_name: fileName });
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

    // ── 3. Insert into lead_corporate_docs (APPEND — keep existing APS) ──────
    // doc_type tells the bridge in completeApsTask which APS task(s) to
    // attach each file to:
    //   "aps_purchase" → Purchase-side APS task only
    //   "aps_sale"     → Sale-side APS task only
    //   "aps"          → both sides (legacy / when side isn't known)
    // We do NOT delete prior APS rows: uploads accumulate so a deal can hold
    // the agreement plus amendments/waivers. Removal is via DELETE
    // /aps-document?file_url=…
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
      .insert(
        files.map((f) => ({
          lead_id: deal.lead_id,
          doc_type: docType,
          custom_type: customType,
          file_url: f.file_url,
          file_name: f.file_name,
        })),
      );

    if (docError) {
      return NextResponse.json(
        {
          success: false,
          error: `Failed to record document: ${docError.message}`,
        },
        { status: 500 },
      );
    }

    // ── 4. Complete the APS task across the family ───────────────────────────
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
      files: files,
      uploaded_count: files.length,
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
