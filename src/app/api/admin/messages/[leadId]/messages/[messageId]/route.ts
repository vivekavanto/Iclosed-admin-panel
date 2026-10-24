import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { resolveMessageActor } from "@/lib/messageActor";
import { deleteStaffMessage, editStaffMessage } from "@/lib/dealMessages";

// One message in a file's chat. [leadId] is the ROOT lead.
//
// PATCH  — { body }: edit your own reply / note (the email is not re-sent).
// DELETE — soft-delete your own reply / note.
//
// Gated to the Messages module by src/middleware.ts.

type Ctx = { params: Promise<{ leadId: string; messageId: string }> };

export async function PATCH(req: Request, { params }: Ctx) {
  const { leadId, messageId } = await params;
  if (!isUuid(leadId) || !isUuid(messageId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  try {
    const { body } = (await req.json().catch(() => ({}))) as { body?: unknown };
    if (typeof body !== "string") {
      return NextResponse.json({ success: false, error: "Message is required" }, { status: 400 });
    }
    const actor = await resolveMessageActor();
    const result = await editStaffMessage({ rootLeadId: leadId, messageId, body, actor });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    await recordAudit({
      action: "chat.message_edited",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "deal_messages",
      resourceId: messageId,
      metadata: { root_lead_id: leadId, kind: result.message.kind },
      req,
    });
    return NextResponse.json({ success: true, data: result.message });
  } catch (err) {
    logger.error("[Inbox] edit failed:", err);
    return NextResponse.json({ success: false, error: "Could not edit the message" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const { leadId, messageId } = await params;
  if (!isUuid(leadId) || !isUuid(messageId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  try {
    const actor = await resolveMessageActor();
    const result = await deleteStaffMessage({ rootLeadId: leadId, messageId, actor });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    await recordAudit({
      action: "chat.message_deleted",
      actorEmail: actor.email,
      actorUserId: actor.id,
      resourceType: "deal_messages",
      resourceId: messageId,
      metadata: { root_lead_id: leadId, kind: result.message.kind },
      req,
    });
    return NextResponse.json({ success: true, data: result.message });
  } catch (err) {
    logger.error("[Inbox] delete failed:", err);
    return NextResponse.json({ success: false, error: "Could not delete the message" }, { status: 500 });
  }
}
