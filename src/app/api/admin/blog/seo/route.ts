import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { generateBlogSeo } from "@/lib/blogSeo";

/**
 * POST /api/admin/blog/seo — article in, draft search metadata out.
 *
 * Stateless, exactly like the format route: it drafts and returns, and writes
 * nothing. Saving is a separate, explicit PATCH /api/admin/blog/[id], so no
 * post ever carries machine-written metadata an admin has not looked at.
 */

// blogHtmlToText uses sanitize-html, which needs Node, not Edge.
export const runtime = "nodejs";

// The ladder budgets 50s worst case (30 + 20), same as the format route.
export const maxDuration = 60;

export async function POST(req: Request) {
  const { email } = await getActingAdmin();

  const allowed = await rateLimitOk(`blog-seo:${email ?? "unknown"}`, 40, 60);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let payload: { body?: unknown; title?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const body = typeof payload.body === "string" ? payload.body : "";
  const title = typeof payload.title === "string" ? payload.title : "";

  if (!body.trim()) {
    return NextResponse.json(
      { success: false, error: "Write the article before drafting its search metadata." },
      { status: 400 },
    );
  }

  const result = await generateBlogSeo({ body, title });
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 502 });
  }

  return NextResponse.json({ success: true, seo: result.data });
}
