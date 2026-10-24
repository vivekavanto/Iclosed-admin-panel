import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { resolveMessageActor } from "@/lib/messageActor";
import { parseSavedReply } from "@/lib/chatSavedReplies";

// PATCH  /api/admin/messages/saved-replies/[id] — { shortcut, title, body }
// DELETE /api/admin/messages/saved-replies/[id]
//
// Gated to the Messages module by src/middleware.ts.

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  try {
    const parsed = parseSavedReply(await req.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });

    const actor = await resolveMessageActor();
    const { data, error } = await supabaseAdmin
      .from("chat_saved_replies")
      .update({ ...parsed.value, updated_by: actor.email, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, shortcut, title, body, sort_order")
      .maybeSingle();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ success: false, error: `${parsed.value.shortcut} is already used by another reply.` }, { status: 409 });
      }
      throw new Error(error.message);
    }
    if (!data) return NextResponse.json({ success: false, error: "Saved reply not found" }, { status: 404 });
    await recordAudit({
      action: "chat.saved_reply_updated",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "chat_saved_replies",
      resourceId: id,
      metadata: { shortcut: data.shortcut },
      req,
    });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    logger.error("[SavedReplies] update failed:", err);
    return NextResponse.json({ success: false, error: "Could not save the reply" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  try {
    const actor = await resolveMessageActor();
    const { data, error } = await supabaseAdmin
      .from("chat_saved_replies")
      .delete()
      .eq("id", id)
      .select("id, shortcut")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ success: false, error: "Saved reply not found" }, { status: 404 });
    await recordAudit({
      action: "chat.saved_reply_deleted",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "chat_saved_replies",
      resourceId: id,
      metadata: { shortcut: data.shortcut },
      req,
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("[SavedReplies] delete failed:", err);
    return NextResponse.json({ success: false, error: "Could not delete the reply" }, { status: 500 });
  }
}
