import { NextResponse, after } from "next/server";
import { verifyServiceSignature } from "@/lib/verifyServiceSignature";
import { runImportWorker } from "@/lib/blogImportQueue";
import { logger } from "@/lib/logger";

/**
 * POST /api/internal/blog-import/run — one worker invocation of the blog
 * import queue (src/lib/blogImportQueue.ts).
 *
 * Only ever called by the app itself (kickImportWorker), so it lives outside
 * /api/admin — a server-to-server call carries no admin session cookie for
 * src/middleware.ts to check. Instead it requires an HMAC signature keyed on
 * SERVICE_WEBHOOK_SECRET, and FAILS CLOSED: unlike the portal webhooks there is
 * no legacy caller to keep working, and the Blogs page's own poll still drains
 * the queue if this route is refused.
 *
 * Answers 202 at once and does the work in after(), so the caller (often
 * another worker handing over) is never held.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request) {
  const raw = await req.text();
  const check = verifyServiceSignature(req, raw);
  if (!check.ok) {
    logger.warn(`[blogImportWorker] rejected: ${check.reason}`);
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const origin = new URL(req.url).origin;
  after(() => runImportWorker(origin));
  return NextResponse.json({ success: true }, { status: 202 });
}
