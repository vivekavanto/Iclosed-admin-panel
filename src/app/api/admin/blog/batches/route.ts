import { NextResponse, after } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { recordAudit } from "@/lib/recordAudit";
import { isBlobUrl } from "@/lib/blobPrivacy";
import {
  enqueueImportBatch,
  finishBatchIfDone,
  isBatchActive,
  kickImportWorker,
  listVisibleBatches,
  runOneJob,
} from "@/lib/blogImportQueue";

/**
 * Background multi-blog import (see src/lib/blogImportQueue.ts).
 *
 * POST { blobUrl, fileName, publishWhenReady? } — queue a document the browser
 *   already uploaded via /api/admin/blog/import/token. Answers in about a
 *   second with { batchId }; the splitting, formatting, SEO and cover images
 *   all happen in the background, straight into draft posts.
 *
 * GET — the batches the progress panel shows, with their articles. While
 *   anything is running it also runs one queued job in after(): the safety net
 *   that keeps a batch moving even if a worker kick was lost.
 */
export const runtime = "nodejs";
// Covers the job a GET may run in after() — see LEASE_SECONDS in the queue lib.
export const maxDuration = 300;

export async function POST(req: Request) {
  const { email } = await getActingAdmin();

  const allowed = await rateLimitOk(`blog-import:${email ?? "unknown"}`, 12, 60);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: "Too many uploads. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : null;
  if (!blobUrl || !isBlobUrl(blobUrl)) {
    return NextResponse.json(
      { success: false, error: "Missing or invalid upload — the document did not reach storage." },
      { status: 400 },
    );
  }
  const fileName =
    typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim().slice(0, 255) : "upload";

  const queued = await enqueueImportBatch({
    blobUrl,
    fileName,
    publishWhenReady: body.publishWhenReady === true,
    adminEmail: email,
  });
  if (!queued.ok) {
    return NextResponse.json({ success: false, error: queued.error }, { status: 500 });
  }

  await recordAudit({
    action: "blog.import_batch_create",
    actorEmail: email,
    resourceType: "blog_post_batch",
    resourceId: queued.batchId,
    metadata: { fileName, publishWhenReady: body.publishWhenReady === true },
    req,
  });

  const origin = new URL(req.url).origin;
  after(() => kickImportWorker(origin, 1));

  return NextResponse.json({ success: true, batchId: queued.batchId });
}

export async function GET(req: Request) {
  const batches = await listVisibleBatches();

  const active = batches.filter(isBatchActive);
  if (active.length > 0) {
    const origin = new URL(req.url).origin;
    after(async () => {
      // Closes batches whose last item was failed by a lease timeout rather
      // than by a worker (nobody else would notice they are finished).
      await Promise.all(
        active.filter((b) => b.status === "processing").map((b) => finishBatchIfDone(b.id)),
      );
      await runOneJob(origin);
    });
  }

  return NextResponse.json({ success: true, batches });
}
