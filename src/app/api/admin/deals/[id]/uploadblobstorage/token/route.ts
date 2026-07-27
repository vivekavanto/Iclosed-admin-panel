import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { blobToken } from "@/lib/blobPrivacy";

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
 * Admin uploads are allowed to replace an existing APS — the finalize
 * endpoint clears prior APS docs/responses before recording the new one.
 * So this token endpoint only validates that the deal exists and has a
 * linked lead.
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
      // Client sends access: BLOB_ACCESS; the generated token must target the
      // matching store — private store's token once the flag is on (SEC-003).
      token: blobToken(),
      onBeforeGenerateToken: async (_pathname, _clientPayload) => {
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

        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_SIZE_BYTES,
          tokenPayload: JSON.stringify({ dealId, leadId: deal.lead_id }),
          addRandomSuffix: false,
          // SEC-024: the browser uses this token immediately after issuance, so
          // cap its life at 2 minutes to shrink the replay window if it leaks.
          validUntil: Date.now() + 2 * 60 * 1000,
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
