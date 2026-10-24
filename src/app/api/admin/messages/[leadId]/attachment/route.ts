import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { isBlobUrl } from "@/lib/blobPrivacy";
import { findThreadAttachment } from "@/lib/dealMessages";
import { serveBlobFile } from "@/lib/serveBlobFile";
import { asciiFilename } from "@/lib/chatAttachments";

/**
 * GET /api/admin/messages/[leadId]/attachment?u=<blob url>[&download=1]
 *
 * Opens a chat attachment for staff. Served only when the URL is attached to a
 * live message in THIS file's thread, so the route can't be used to read an
 * arbitrary blob (and works for staff who have Messages but not the document
 * modules). Public blobs redirect; private ones stream.
 *
 * Gated to the Messages module by src/middleware.ts.
 */
export const runtime = "nodejs";

type Ctx = { params: Promise<{ leadId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { leadId } = await params;
  const url = new URL(req.url);
  const u = url.searchParams.get("u") ?? "";
  if (!isUuid(leadId) || !isBlobUrl(u)) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }
  try {
    const attachment = await findThreadAttachment(leadId, u);
    if (!attachment) {
      return NextResponse.json({ success: false, error: "Attachment not found" }, { status: 404 });
    }
    const served = await serveBlobFile({
      fileUrl: attachment.url,
      // A header can't carry non-ASCII; an "é" or emoji in the name would throw.
      filename: asciiFilename(attachment.name),
      forceDownload: url.searchParams.get("download") === "1",
      logLabel: "[Chat attachment]",
    });
    if (!served.ok) {
      return NextResponse.json(
        { success: false, error: served.reason === "missing" ? "Attachment no longer available" : "Could not open the attachment" },
        { status: served.reason === "missing" ? 404 : 500 },
      );
    }
    return served.response;
  } catch (err) {
    logger.error("[Chat attachment] failed:", err);
    return NextResponse.json({ success: false, error: "Could not open the attachment" }, { status: 500 });
  }
}
