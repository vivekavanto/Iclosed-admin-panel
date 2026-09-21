import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getPostById, updatePost, deletePost } from "@/lib/blogPosts";
import { pickWritable } from "../route";

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

  return NextResponse.json({ success: true, post: result.row });
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

  return NextResponse.json({ success: true });
}
