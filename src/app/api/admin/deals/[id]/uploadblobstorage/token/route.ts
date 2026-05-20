import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * POST /api/admin/deals/[id]/uploadblobstorage/token
 *
 * Issues a short-lived upload token so the admin browser can `upload()`
 * (via @vercel/blob/client) the APS file directly to Vercel Blob. This
 * bypasses Vercel's 4.5MB serverless body limit so we can accept files
 * up to 10MB — mirroring the customer portal's APS upload flow.
 *
 * Validates here so we never issue a token for a deal that:
 *   - doesn't exist
 *   - has no lead_id (pre-conversion / bulk-imported)
 *   - already has an APS document uploaded anywhere in its family
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: dealId } = await params;

  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (_pathname, _clientPayload) => {
        // 1. Resolve deal → lead
        const { data: deal, error: dealError } = await supabaseAdmin
          .from("deals")
          .select("id, lead_id")
          .eq("id", dealId)
          .maybeSingle();

        if (dealError) throw new Error(dealError.message);
        if (!deal) throw new Error("Deal not found");
        if (!deal.lead_id) {
          throw new Error(
            "This deal has no linked lead yet (bulk-imported). Convert the lead before uploading an APS.",
          );
        }

        // 2. Already-uploaded guard across the co-purchaser/co-seller family
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
              throw new Error("APS document is already uploaded for this deal.");
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
            throw new Error("APS document is already uploaded for this deal.");
          }
        }

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_SIZE_BYTES,
          tokenPayload: JSON.stringify({ dealId, leadId: deal.lead_id }),
          addRandomSuffix: false,
        };
      },
      onUploadCompleted: async () => {
        // No-op. The admin browser calls the finalize endpoint
        // (/api/admin/deals/[id]/uploadblobstorage) directly after the
        // upload returns. Vercel webhooks aren't reachable in local dev,
        // so we don't rely on this callback.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Token generation failed" },
      { status: 400 },
    );
  }
}
