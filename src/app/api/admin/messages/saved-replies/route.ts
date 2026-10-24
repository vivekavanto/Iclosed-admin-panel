import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { resolveMessageActor } from "@/lib/messageActor";
import { isMissingRelation, listSavedReplies, parseSavedReply } from "@/lib/chatSavedReplies";

// GET  /api/admin/messages/saved-replies — { data, editable } for the composer.
//      editable=false means the table doesn't exist yet (built-in list shown).
// POST /api/admin/messages/saved-replies — { shortcut, title, body } adds one.
//
// Gated to the Messages module by src/middleware.ts.

export async function GET() {
  try {
    const { replies, editable } = await listSavedReplies();
    return NextResponse.json({ success: true, data: replies, editable });
  } catch (err) {
    logger.error("[SavedReplies] list failed:", err);
    return NextResponse.json({ success: false, error: "Could not load saved replies" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const parsed = parseSavedReply(await req.json().catch(() => ({})));
    if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });

    const actor = await resolveMessageActor();
    const { data: last } = await supabaseAdmin
      .from("chat_saved_replies")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1);
    const { data, error } = await supabaseAdmin
      .from("chat_saved_replies")
      .insert({
        ...parsed.value,
        sort_order: ((last?.[0]?.sort_order as number | undefined) ?? 0) + 10,
        created_by: actor.email,
        updated_by: actor.email,
      })
      .select("id, shortcut, title, body, sort_order")
      .single();
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json({ success: false, error: `${parsed.value.shortcut} is already used by another reply.` }, { status: 409 });
      }
      if (isMissingRelation(error.code)) {
        return NextResponse.json({ success: false, error: "Saved replies can't be edited until the chat migration has been run." }, { status: 409 });
      }
      throw new Error(error.message);
    }
    await recordAudit({
      action: "chat.saved_reply_created",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "chat_saved_replies",
      resourceId: data.id,
      metadata: { shortcut: data.shortcut },
      req,
    });
    return NextResponse.json({ success: true, data });
  } catch (err) {
    logger.error("[SavedReplies] create failed:", err);
    return NextResponse.json({ success: false, error: "Could not save the reply" }, { status: 500 });
  }
}
