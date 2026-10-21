import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { resolveMessageActor } from "@/lib/messageActor";
import {
  ensureConversation,
  familyDeals,
  getConversation,
  loadThread,
  markClientMessagesRead,
  sendAdminMessage,
  setAssignee,
  setStatus,
} from "@/lib/dealMessages";

// One file's conversation. [leadId] is the family's ROOT lead id.
//
// GET   — thread (incl. private notes + events), conversation state, the
//         client's details, their other files, and the staff list for "Assign
//         to". Opening it marks the client's messages as seen.
// POST  — { body, kind: "message" | "note" }: a reply (saved + emailed) or a
//         private note (saved only).
// PATCH — { action: "assign", email | null } | { action: "resolve" } | { action: "reopen" }
//
// Gated to admins by src/middleware.ts.

type Ctx = { params: Promise<{ leadId: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { leadId } = await params;
  if (!isUuid(leadId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  try {
    const [messages, conversation, deals, staff] = await Promise.all([
      loadThread(leadId),
      getConversation(leadId),
      familyDeals(leadId),
      supabaseAdmin.from("admin_users").select("name, email").eq("is_active", true).order("name"),
    ]);
    await markClientMessagesRead(leadId);

    const { data: family } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, phone, parent_lead_id, client_id, lead_type")
      .or(`id.eq.${leadId},parent_lead_id.eq.${leadId}`);
    const people = (family ?? []).map((l) => ({
      name: `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim() || l.email || "Client",
      email: l.email as string | null,
      phone: l.phone as string | null,
      primary: l.id === leadId,
    }));
    people.sort((a, b) => Number(b.primary) - Number(a.primary));

    // The client's other files (different families), newest first.
    const clientIds = [...new Set((family ?? []).map((l) => l.client_id).filter(Boolean))] as string[];
    const familyIds = new Set(deals.map((d) => d.id));
    const { data: others } = clientIds.length
      ? await supabaseAdmin
          .from("deals")
          .select("id, file_number, property_address, created_at")
          .in("client_id", clientIds)
          .eq("is_deleted", false)
          .order("created_at", { ascending: false })
      : { data: [] };

    const main = deals[0] ?? null;
    return NextResponse.json({
      success: true,
      data: {
        messages,
        conversation,
        people,
        file: main
          ? {
              deal_id: main.id,
              file_number: main.file_number,
              type: main.type,
              status: main.status,
              property_address: main.property_address,
              closing_date: main.closing_date,
            }
          : null,
        other_files: (others ?? []).filter((d) => !familyIds.has(d.id)).slice(0, 5),
        staff: (staff.data ?? []).filter((s) => s.email),
      },
    });
  } catch (err) {
    logger.error("[Inbox] thread load failed:", err);
    return NextResponse.json({ success: false, error: "Could not load the conversation" }, { status: 500 });
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { leadId } = await params;
  if (!isUuid(leadId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  try {
    const { body, kind } = (await req.json().catch(() => ({}))) as { body?: unknown; kind?: unknown };
    if (typeof body !== "string") {
      return NextResponse.json({ success: false, error: "Message is required" }, { status: 400 });
    }
    const actor = await resolveMessageActor();
    const result = await sendAdminMessage({
      rootLeadId: leadId,
      body,
      kind: kind === "note" ? "note" : "message",
      sender: { name: actor.name, email: actor.email },
    });
    if (!result.ok) {
      return NextResponse.json({ success: false, error: result.error }, { status: 400 });
    }
    if (kind !== "note") {
      await recordAudit({
        action: "client.message_sent",
        actorEmail: actor.email,
        actorUserId: actor.id,
        resourceType: "leads",
        resourceId: leadId,
        metadata: { message_id: result.message.id, recipients: result.emailed.length },
        req,
      });
    }
    return NextResponse.json({
      success: true,
      data: result.message,
      emailed: result.emailed.length,
      emailError: result.emailError ?? null,
    });
  } catch (err) {
    logger.error("[Inbox] send failed:", err);
    return NextResponse.json({ success: false, error: "Could not send the message" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const { leadId } = await params;
  if (!isUuid(leadId)) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }
  try {
    const { action, email } = (await req.json().catch(() => ({}))) as { action?: string; email?: string | null };
    const actor = await resolveMessageActor();
    await ensureConversation(leadId);

    if (action === "assign") {
      if (email) {
        const { data: person } = await supabaseAdmin
          .from("admin_users")
          .select("name, email")
          .ilike("email", email)
          .eq("is_active", true)
          .maybeSingle();
        if (!person?.email) {
          return NextResponse.json({ success: false, error: "Unknown staff member" }, { status: 400 });
        }
        await setAssignee(leadId, { email: person.email, name: person.name || person.email }, actor);
      } else {
        await setAssignee(leadId, null, actor);
      }
    } else if (action === "resolve" || action === "reopen") {
      await setStatus(leadId, action === "resolve" ? "resolved" : "open", actor);
    } else {
      return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    logger.error("[Inbox] update failed:", err);
    return NextResponse.json({ success: false, error: "Could not update the conversation" }, { status: 500 });
  }
}
