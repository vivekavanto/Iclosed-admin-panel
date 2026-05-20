import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { completeApsTask } from "@/lib/completeApsTask";
import { getFamilyDealIds } from "@/lib/familyDeals";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
]);
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
};

/**
 * POST /api/admin/deals/[id]/uploadblobstorage
 *
 * Admin-side APS upload from the deal detail page. Mirrors the customer
 * portal upload widget: PDF/JPG/JPEG/PNG up to 10MB. Stores the file in
 * Supabase Storage bucket `lead-documents`, records it in
 * `lead_corporate_docs`, then delegates to `completeApsTask`, which:
 *   - bridges the doc into `task_responses` for every APS task on the deal
 *   - marks the APS task(s) Completed
 *   - syncs completion across all linked co-purchaser/co-seller deals
 *   - recalculates milestones for the entire family
 *
 * Refuses to upload if an APS document is already present anywhere in the
 * deal's co-purchaser/co-seller family (returns 409).
 *
 * Body: multipart/form-data with a single `file` field.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: dealId } = await params;

    // ── 1. Parse + validate the upload ───────────────────────────────────────
    const form = await req.formData();
    const file = form.get("file");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { success: false, error: "file is required" },
        { status: 400 },
      );
    }

    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json(
        { success: false, error: "Only PDF, JPG, JPEG or PNG files are accepted" },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { success: false, error: "File is empty" },
        { status: 400 },
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { success: false, error: "File exceeds the 10MB maximum size" },
        { status: 400 },
      );
    }

    const originalName = (file as File).name || "APS";
    const fileName = originalName;
    const ext = MIME_TO_EXT[file.type] ?? "bin";

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

    // ── 3. Guard: already uploaded anywhere in the family? ───────────────────
    // Customer portal uploads land in `task_responses` (on the APS task);
    // Intake uploads land in `lead_corporate_docs` and get bridged by
    // completeApsTask. Either signal means "already uploaded".
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
        const { data: existingResponses } = await supabaseAdmin
          .from("task_responses")
          .select("id")
          .in("task_id", apsTaskIds)
          .eq("field_type", "file")
          .not("file_url", "is", null)
          .limit(1);

        if (existingResponses && existingResponses.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: "APS document is already uploaded for this deal.",
            },
            { status: 409 },
          );
        }
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
      const { data: existingDocs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("id")
        .in("lead_id", familyLeadIds)
        .or(
          "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%",
        )
        .limit(1);

      if (existingDocs && existingDocs.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: "APS document is already uploaded for this deal.",
          },
          { status: 409 },
        );
      }
    }

    // ── 4. Upload to Supabase Storage ────────────────────────────────────────
    const objectId = crypto.randomUUID();
    const storagePath = `${deal.lead_id}/${objectId}.${ext}`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from("lead-documents")
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      });

    if (uploadError) {
      return NextResponse.json(
        { success: false, error: `Upload failed: ${uploadError.message}` },
        { status: 500 },
      );
    }

    const { data: urlData } = supabaseAdmin.storage
      .from("lead-documents")
      .getPublicUrl(storagePath);
    const fileUrl = urlData.publicUrl;

    // ── 5. Insert into lead_corporate_docs ───────────────────────────────────
    // doc_type = "aps" is the generic value: completeApsTask's bridging treats
    // it as applying to all APS task lead_types (Purchase + Sale), which is
    // what we want — admin upload is a single document for the whole deal.
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

    // ── 6. Complete the APS task across the family ───────────────────────────
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
