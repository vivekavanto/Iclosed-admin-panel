import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { listAllPosts, createPost } from "@/lib/blogPosts";
import {pickWritable} from "@/lib/blogWrite";
import { recordAudit } from "@/lib/recordAudit";

/**
 * GET  /api/admin/blog — every post, any status. The Blogs list.
 * POST /api/admin/blog — create a draft.
 *
 * Auth is src/middleware.ts: everything under /api/admin/* already requires an
 * authenticated admin session, so there is no per-route gate here. What
 * getActingAdmin() adds is the identity — created_by_email / updated_by_email
 * are the reviewer of record on a post, and a blog row outlives the person who
 * wrote it.
 *
 * The customer portal (iclosed_dev_web) has its own /api/blog handlers over the
 * same table for its reader surfaces. These are the authoring side.
 */
export const runtime = "nodejs";

export async function GET() {
  const posts = await listAllPosts();
  return NextResponse.json({ success: true, posts });
}

export async function POST(req: Request) {
  const { email } = await getActingAdmin();

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  // A new post is always a draft, whatever the caller asked for. Publishing is
  // a separate, deliberate call to /api/admin/blog/[id]/publish — there is no
  // path that creates live content in one step.
  const fields = { ...pickWritable(payload), status: "draft" as const };

  const result = await createPost(fields, email ?? "unknown");
  if (!result.ok) {
    return NextResponse.json({ success: false, error: result.error }, { status: 400 });
  }

  // Only a multi-blog import sets import_batch_id — a batch is traceable end
  // to end by querying audit_logs for this metadata key, without adding a row
  // per single-post creation the rest of the time.
  if (result.row.import_batch_id) {
    await recordAudit({
      action: "blog.import_create",
      actorEmail: email,
      resourceType: "blog_post",
      resourceId: result.row.id,
      metadata: { batchId: result.row.import_batch_id, title: result.row.title },
      req,
    });
  }

  return NextResponse.json({ success: true, post: result.row }, { status: 201 });
}
