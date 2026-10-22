import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/isUuid";
import { rootLeadOfDeal } from "@/lib/dealMessages";
import { staffChannels } from "@/lib/chatRealtime";
import { clientIsOnline } from "@/lib/chatPresence";

// GET /api/admin/messages            — the inbox: one row per file conversation.
// GET /api/admin/messages?summary=1  — just { unread } for the sidebar badge.
// Both also return `realtime` (channel names; {} when realtime is off).
//
// Gated to admins by src/middleware.ts.

const MAX_CONVERSATIONS = 300;

export async function GET(req: Request) {
  try {
    // "Message this client" from a deal page: deal id -> the conversation's key.
    const dealParam = new URL(req.url).searchParams.get("deal_id");
    if (dealParam) {
      if (!isUuid(dealParam)) {
        return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
      }
      return NextResponse.json({ success: true, root: await rootLeadOfDeal(dealParam) });
    }

    if (new URL(req.url).searchParams.get("summary")) {
      const { count } = await supabaseAdmin
        .from("deal_messages")
        .select("id", { count: "exact", head: true })
        .eq("sender_type", "client")
        .eq("kind", "message")
        .is("read_by_admin_at", null);
      return NextResponse.json({ success: true, unread: count ?? 0, realtime: staffChannels() });
    }

    const { data: convs, error } = await supabaseAdmin
      .from("deal_conversations")
      .select("root_lead_id, status, assignee_email, assignee_name, last_message_at")
      .order("last_message_at", { ascending: false })
      .limit(MAX_CONVERSATIONS);
    if (error) throw new Error(error.message);
    const roots = (convs ?? []).map((c) => c.root_lead_id);
    if (roots.length === 0) return NextResponse.json({ success: true, data: [], realtime: staffChannels() });

    const [{ data: leads }, { data: kids }, { data: deals }, { data: msgs }, { data: presence }] = await Promise.all([
      supabaseAdmin.from("leads").select("id, first_name, last_name, email").in("id", roots),
      supabaseAdmin.from("leads").select("parent_lead_id").in("parent_lead_id", roots),
      supabaseAdmin
        .from("deals")
        .select("lead_id, file_number, property_address, created_at")
        .in("lead_id", roots)
        .eq("is_deleted", false)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("deal_messages")
        .select("root_lead_id, sender_type, sender_name, body, source, created_at, read_by_admin_at")
        .in("root_lead_id", roots)
        .eq("kind", "message")
        .order("created_at", { ascending: false })
        .limit(4000),
      // Separate query on purpose: before migrations/2026-10-22-chat-presence.sql
      // has run these columns don't exist, and the error must not empty the inbox.
      supabaseAdmin
        .from("deal_conversations")
        .select("root_lead_id, client_online, client_last_seen_at")
        .in("root_lead_id", roots),
    ]);
    const presenceBy = new Map(
      ((presence ?? []) as { root_lead_id: string; client_online: boolean | null; client_last_seen_at: string | null }[]).map(
        (p) => [p.root_lead_id, p],
      ),
    );

    const leadBy = new Map((leads ?? []).map((l) => [l.id, l]));
    const fileBy = new Map<string, string | null>();
    const addressBy = new Map<string, string | null>();
    for (const d of deals ?? []) {
      if (!fileBy.has(d.lead_id)) fileBy.set(d.lead_id, d.file_number);
      if (!addressBy.has(d.lead_id)) addressBy.set(d.lead_id, d.property_address);
    }
    const coCount = new Map<string, number>();
    for (const k of kids ?? []) coCount.set(k.parent_lead_id, (coCount.get(k.parent_lead_id) ?? 0) + 1);

    const last = new Map<string, NonNullable<typeof msgs>[number]>();
    const unread = new Map<string, number>();
    const lastClientSource = new Map<string, string>();
    for (const m of msgs ?? []) {
      if (!last.has(m.root_lead_id)) last.set(m.root_lead_id, m);
      if (m.sender_type === "client") {
        if (!lastClientSource.has(m.root_lead_id)) lastClientSource.set(m.root_lead_id, m.source);
        if (!m.read_by_admin_at) unread.set(m.root_lead_id, (unread.get(m.root_lead_id) ?? 0) + 1);
      }
    }

    const data = (convs ?? [])
      .filter((c) => last.has(c.root_lead_id))
      .map((c) => {
        const lead = leadBy.get(c.root_lead_id);
        const lm = last.get(c.root_lead_id)!;
        const name = `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || lead?.email || "Client";
        return {
          id: c.root_lead_id,
          name,
          co_count: coCount.get(c.root_lead_id) ?? 0,
          file_number: fileBy.get(c.root_lead_id) ?? null,
          property_address: addressBy.get(c.root_lead_id) ?? null,
          status: c.status,
          assignee_email: c.assignee_email,
          assignee_name: c.assignee_name,
          preview: `${lm.sender_type === "admin" ? "You: " : ""}${lm.body}`.slice(0, 160),
          last_at: lm.created_at,
          unread: unread.get(c.root_lead_id) ?? 0,
          channel: lastClientSource.get(c.root_lead_id) === "email" ? "email" : "portal",
          client_online: clientIsOnline(presenceBy.get(c.root_lead_id)),
          client_last_seen_at: presenceBy.get(c.root_lead_id)?.client_last_seen_at ?? null,
        };
      });

    return NextResponse.json({ success: true, data, realtime: staffChannels() });
  } catch (err) {
    logger.error("[Inbox] list failed:", err);
    return NextResponse.json({ success: false, error: "Could not load conversations" }, { status: 500 });
  }
}
