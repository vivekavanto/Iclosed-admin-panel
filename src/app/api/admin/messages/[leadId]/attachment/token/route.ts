import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { blobToken, PRIVATE_BLOB_ENABLED } from "@/lib/blobPrivacy";
import {
  CHAT_ATTACHMENT_TYPES,
  MAX_ATTACHMENT_BYTES,
  chatAttachmentPrefix,
} from "@/lib/chatAttachments";

/**
 * POST /api/admin/messages/[leadId]/attachment/token
 *
 * Upload token for a chat attachment, so the staff browser `upload()`s the file
 * straight to Vercel Blob (no 4.5 MB function body cap). [leadId] is the file's
 * ROOT lead. The token only allows a pathname under chat/<root>/ — the send
 * route later refuses any attachment outside that prefix, so a file can never
 * be attached to a different file's chat.
 *
 * Gated to the Messages module by src/middleware.ts.
 */
type Ctx = { params: Promise<{ leadId: string }> };

export async function POST(request: Request, { params }: Ctx) {
  const { leadId } = await params;
  if (!isUuid(leadId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  try {
    const token = blobToken();
    if (PRIVATE_BLOB_ENABLED && !token) {
      return NextResponse.json(
        { error: "Blob storage misconfigured: BLOB_PRIVATE_READ_WRITE_TOKEN is not set." },
        { status: 500 },
      );
    }
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      token,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(chatAttachmentPrefix(leadId))) {
          throw new Error("Invalid upload path.");
        }
        const { data: lead, error } = await supabaseAdmin
          .from("leads")
          .select("id, parent_lead_id")
          .eq("id", leadId)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!lead || lead.parent_lead_id) throw new Error("File not found.");
        return {
          // Blob itself rejects a PUT that breaks these.
          allowedContentTypes: CHAT_ATTACHMENT_TYPES,
          maximumSizeInBytes: MAX_ATTACHMENT_BYTES,
          // Unguessable URL even on the public store.
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ root: leadId }),
          validUntil: Date.now() + 2 * 60 * 1000,
        };
      },
      onUploadCompleted: async () => {
        // No-op: the browser sends the URL with the message, and the send route
        // verifies it. Vercel's callback can't reach local dev anyway.
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Upload token generation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
