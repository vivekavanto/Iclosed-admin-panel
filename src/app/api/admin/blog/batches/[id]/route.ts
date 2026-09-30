import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { cancelBatch, dismissBatch } from "@/lib/blogImportQueue";

/**
 * PATCH /api/admin/blog/batches/[id]  { action: "cancel" | "dismiss" }
 *
 *   cancel   stop a running import; drafts already created are kept
 *   dismiss  hide a failed import from the progress panel
 */
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid batch id." }, { status: 400 });
  }

  let action: unknown;
  try {
    action = ((await req.json()) as { action?: unknown }).action;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const { email } = await getActingAdmin();

  if (action === "cancel") {
    const ok = await cancelBatch(id);
    if (!ok) {
      return NextResponse.json({ success: false, error: "This import is not running." }, { status: 400 });
    }
    await recordAudit({
      action: "blog.import_batch_cancel",
      actorEmail: email,
      resourceType: "blog_post_batch",
      resourceId: id,
      req,
    });
    return NextResponse.json({ success: true });
  }

  if (action === "dismiss") {
    await dismissBatch(id);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ success: false, error: "Unknown action." }, { status: 400 });
}
