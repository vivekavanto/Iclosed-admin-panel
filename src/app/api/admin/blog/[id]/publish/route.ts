import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getPostById, updatePost } from "@/lib/blogPosts";

/**
 * POST /api/admin/blog/[id]/publish — take a post live, or pull it back to
 * draft. Body: { publish: boolean }.
 *
 * The only transition into `published`. Keeping it on its own route means the
 * pre-flight checks below can never be skipped by a caller that only meant to
 * save a field.
 *
 * A published post appears on the portal within its own revalidate window
 * (about five minutes). This app cannot revalidate the portal's cache, and the
 * paths it would name do not exist here — see the note in src/lib/blogPosts.ts.
 */
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid post id." }, { status: 400 });
  }

  const { email } = await getActingAdmin();

  const post = await getPostById(id);
  if (!post) {
    return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
  }

  let publish = true;
  try {
    const payload = (await req.json()) as { publish?: unknown };
    if (typeof payload.publish === "boolean") publish = payload.publish;
  } catch {
    // An empty body means "publish" — the common case from a single button.
  }

  if (publish) {
    // Refuse to publish an empty shell. A live URL with no body is worse than
    // no URL at all: Google indexes it, and thin content is a ranking penalty
    // that outlasts the mistake.
    if (!post.content_html || post.content_html.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "This post has no content yet." },
        { status: 400 },
      );
    }
    if (!post.excerpt?.trim()) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Add a short excerpt before publishing — it is what shows on the blog listing and in search results.",
        },
        { status: 400 },
      );
    }
  }

  const result = await updatePost(
    id,
    {
      status: publish ? "published" : "draft",
      // First publish sets the date; re-publishing later keeps the original, so
      // an edit does not reset a post's age and lose its accumulated authority.
      published_at: publish ? (post.published_at ?? new Date().toISOString()) : post.published_at,
    },
    email ?? "unknown",
  );

  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  return NextResponse.json({ success: true, post: result.row });
}
