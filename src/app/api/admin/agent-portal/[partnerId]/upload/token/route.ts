import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { blobToken } from "@/lib/blobPrivacy";
import { AGENT_UPLOAD_PREFIX } from "@/lib/agentPortal";
import { loadAgentRootLead, loadAgentTask } from "@/lib/agentPortalData";

const ALLOWED_CONTENT_TYPES = ["application/pdf", "image/jpeg", "image/jpg", "image/png"];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// POST — a short-lived Blob upload token for one of the agent's files.
// clientPayload: { taskId } for a task document, { leadId } (root lead) for an Other Document.
export async function POST(request: Request, { params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  if (!isUuid(partnerId)) return NextResponse.json({ error: "Invalid partner id" }, { status: 400 });

  try {
    const body = (await request.json()) as HandleUploadBody;
    const jsonResponse = await handleUpload({
      body,
      request,
      token: blobToken(),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const { taskId, leadId } = JSON.parse(clientPayload ?? "{}") as { taskId?: unknown; leadId?: unknown };
        let owner: string | null = null;
        if (typeof taskId === "string" && isUuid(taskId)) owner = (await loadAgentTask(partnerId, taskId))?.lead_id ?? null;
        else if (typeof leadId === "string" && isUuid(leadId)) owner = await loadAgentRootLead(partnerId, leadId);
        if (!owner) throw new Error("Not one of this agent's files");
        if (!pathname.startsWith(`${AGENT_UPLOAD_PREFIX}/${owner}/`)) throw new Error("Invalid upload path");
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_SIZE_BYTES,
          tokenPayload: JSON.stringify({ partnerId, leadId: owner }),
          addRandomSuffix: false,
          validUntil: Date.now() + 2 * 60 * 1000,
        };
      },
      onUploadCompleted: async () => {
        // No-op: the browser finalises through ../upload (webhooks don't reach local dev).
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Token generation failed" }, { status: 400 });
  }
}
