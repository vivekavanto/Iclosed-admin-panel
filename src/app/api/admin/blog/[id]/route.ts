import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getPostById, updatePost, deletePost } from "@/lib/blogPosts";
import { revalidatePortalBlog } from "@/lib/revalidatePortalBlog";
import { pickWritable } from "@/lib/blogWrite";

/**
 * GET / PATCH / DELETE a single post. Admin-gated by src/middleware.ts.
 */
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

function badId() {
  return NextResponse.json({ success: false, error: "Invalid post id." }, { status: 400 });
}

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return badId();

  const post = await getPostById(id);
  if (!post) {
    return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
  }
  return NextResponse.json({ success: true, post });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return badId();

  const { email } = await getActingAdmin();

  const before = await getPostById(id);
  if (!before) {
    return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // `status` is not editable here — /api/admin/blog/[id]/publish owns that
  // transition, so going live always runs through one code path.
  const fields = pickWritable(payload);
  delete (fields as Record<string, unknown>).status;

  const result = await updatePost(id, fields, email ?? "unknown");
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  // Editing an already-live post (a swapped cover image, a text fix, ...) has
  // to reach readers without waiting on the portal's 5-minute ISR timer. Both
  // slugs when it moved, or the old URL keeps serving the old copy from cache.
  let revalidated: boolean | null = null;
  if (before.status !== "draft") {
    revalidated = await revalidatePortalBlog({
      slug: result.row.slug,
      previousSlug: result.row.slug !== before.slug ? before.slug : undefined,
    });
  }

  return NextResponse.json({ success: true, post: result.row, revalidated });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return badId();

  const before = await getPostById(id);
  if (!before) {
    return NextResponse.json({ success: false, error: "Post not found." }, { status: 404 });
  }

  const result = await deletePost(id);
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  if (before.status !== "draft") {
    await revalidatePortalBlog({ slug: before.slug });
  }

  return NextResponse.json({ success: true });
}
