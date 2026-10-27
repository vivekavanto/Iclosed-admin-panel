import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { blobToken } from "@/lib/blobPrivacy";
import { allowedUploadContentTypesForDocType, maxUploadBytesForDocType } from "@/lib/uploadValidation";
import { AGENT_UPLOAD_PREFIX } from "@/lib/agentPortal";
import { loadAgentRootLead } from "@/lib/agentPortalData";
import { OTHER_DOC_TYPE } from "@/lib/agentFileExtras";

// POST — a short-lived Blob upload token for one of the agent's Other Documents.
// Same types and 30 MB cap as the file page's Other Documents.
export async function POST(request: Request, { params }: { params: Promise<{ partnerId: string; leadId: string }> }) {
  const { partnerId, leadId } = await params;
  if (!isUuid(partnerId) || !isUuid(leadId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  try {
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      token: blobToken(),
      onBeforeGenerateToken: async (pathname) => {
        const root = await loadAgentRootLead(partnerId, leadId);
        if (!root) throw new Error("Not one of this agent's files");
        if (!pathname.startsWith(`${AGENT_UPLOAD_PREFIX}/${root}/`)) throw new Error("Invalid upload path");
        return {
          allowedContentTypes: allowedUploadContentTypesForDocType(OTHER_DOC_TYPE),
          maximumSizeInBytes: maxUploadBytesForDocType(OTHER_DOC_TYPE),
          tokenPayload: JSON.stringify({ partnerId, leadId: root }),
          addRandomSuffix: false,
          validUntil: Date.now() + 2 * 60 * 1000,
        };
      },
      onUploadCompleted: async () => {
        // No-op: the browser records it through ../documents (webhooks don't reach local dev).
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Token generation failed" }, { status: 400 });
  }
}
