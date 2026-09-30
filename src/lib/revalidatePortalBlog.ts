import { logger } from "./logger";

/**
 * Tells the portal (iclosed_dev_web) to drop its cached copy of a blog post
 * right away, instead of readers waiting out that app's /blogs and
 * /blogs/[slug] revalidate(300) window (up to 5 minutes stale).
 *
 * This app writes straight to the shared `blog_posts` table — see the note in
 * blogPosts.ts — and has no Next.js cache of its own to invalidate here; this
 * only reaches across to the portal's cache.
 *
 * Best-effort and silent: a failed or skipped call must never fail the save
 * that triggered it. Worst case, the portal's own 5-minute timer still
 * catches it, exactly as it did before this existed.
 *
 * Portal side: POST /api/admin/revalidate-blog, gated by the same
 * ADMIN_SERVICE_KEY / x-service-key check as the rest of that app's
 * /api/admin/* routes (its src/middleware.ts adminGate) — the key is already
 * tracked as a shared, rotated secret in docs/key-rotation.md.
 */
/**
 * Returns whether the portal actually dropped its cache. The caller uses this
 * only to tell the admin what happened — never to decide whether the save
 * itself succeeded, since the post row is already written by this point.
 */
export async function revalidatePortalBlog(opts: {
  slug?: string | null;
  previousSlug?: string | null;
}): Promise<boolean> {
  const base = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").replace(/\/+$/, "");
  const key = process.env.ADMIN_SERVICE_KEY;
  if (!base || !key) {
    logger.warn(
      "[revalidatePortalBlog] skipped — NEXT_PUBLIC_CUSTOMER_PORTAL_URL or ADMIN_SERVICE_KEY not configured",
    );
    return false;
  }

  try {
    const res = await fetch(`${base}/api/admin/revalidate-blog`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-key": key,
      },
      body: JSON.stringify({
        slug: opts.slug || undefined,
        previousSlug: opts.previousSlug || undefined,
      }),
    });
    if (!res.ok) {
      logger.warn(`[revalidatePortalBlog] portal responded ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("[revalidatePortalBlog] could not reach the portal:", err);
    return false;
  }
}
