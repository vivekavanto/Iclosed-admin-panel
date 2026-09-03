import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { blobToken } from "@/lib/blobPrivacy";
import {
  ALLOWED_UPLOAD_CONTENT_TYPES,
  maxUploadBytesForDocType,
} from "@/lib/uploadValidation";

/**
 * POST /api/admin/uploadblobstorage/token
 *
 * Issues a short-lived upload token so the admin browser can `upload()` a
 * document (identification / corporate doc) DIRECTLY to Vercel Blob via
 * @vercel/blob/client, instead of streaming it through this function.
 *
 * Why: Vercel caps a serverless function's request body at ~4.5 MB, so the old
 * browser -> route -> put() path failed with FUNCTION_PAYLOAD_TOO_LARGE for any
 * file above that — even though the app advertises a 10 MB limit. With a client
 * upload the bytes never touch the function, so the full 10 MB works. Mirrors
 * the APS flow's token route (deals/[id]/uploadblobstorage/token).
 *
 * Auth: src/middleware.ts requires an authenticated admin session for every
 * /api/admin/* path, so reaching this handler already means "trusted admin".
 * The lead is still verified here so a token can't be minted for a lead that
 * doesn't exist.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request,
      // The client sends access: BLOB_ACCESS; the generated token has to target
      // the matching store — the private store's token once the flag is on
      // (SEC-003).
      token: blobToken(),
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        let leadId: string | null = null;
        // The doc_type decides the size ceiling: a final reporting package is
        // routinely 15-25 MB, every other document stays on the 10 MB cap.
        let docType: string | null = null;
        try {
          const parsed = clientPayload ? JSON.parse(clientPayload) : null;
          leadId = typeof parsed?.lead_id === "string" ? parsed.lead_id : null;
          docType = typeof parsed?.doc_type === "string" ? parsed.doc_type : null;
        } catch {
          throw new Error("Invalid upload payload.");
        }

        if (!leadId) throw new Error("lead_id is required to upload a document.");

        const { data: lead, error } = await supabaseAdmin
          .from("leads")
          .select("id")
          .eq("id", leadId)
          .maybeSingle();

        if (error) throw new Error(error.message);
        if (!lead) throw new Error("Lead not found.");

        return {
          // Blob rejects the PUT itself if the browser lies about either of
          // these — this is the real server-side enforcement point now that the
          // bytes don't pass through the app.
          allowedContentTypes: ALLOWED_UPLOAD_CONTENT_TYPES,
          maximumSizeInBytes: maxUploadBytesForDocType(docType),
          tokenPayload: JSON.stringify({ leadId, docType }),
          addRandomSuffix: false,
          // SEC-024: the browser uses this token immediately, so cap its life at
          // 2 minutes to shrink the replay window if it leaks.
          validUntil: Date.now() + 2 * 60 * 1000,
        };
      },
      onUploadCompleted: async () => {
        // No-op. The browser calls POST /api/admin/uploadblobstorage with the
        // returned URL to create the lead_corporate_docs row. Vercel's webhook
        // isn't reachable in local dev, so we never depend on this callback.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : "Upload token generation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
