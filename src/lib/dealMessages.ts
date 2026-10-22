// Client <-> staff live chat on a file.
//
// Flow:
//   staff reply in the Inbox (/admin/messages) -> row in deal_messages -> email
//   to the file's clients (Reply-To is a per-file address) -> the client either
//   REPLIES TO THE EMAIL (ingested by /api/webhooks/inbound-email) or answers
//   in the chat widget in their portal (which writes the same table, then pings
//   /api/webhooks/client-message so the staff bell lights up).
//
// A CONVERSATION belongs to the FILE, keyed by the family's ROOT lead
// (leads.parent_lead_id ?? leads.id) — co-clients and all staff share one thread.
// Private notes (kind 'note') and internal events never reach the client: the
// portal only reads rows with visible_to_client = true.
//
// The portal repo reads/writes the same tables (iclosed_dev_web/src/lib/dealMessages.ts);
// the kind / sender_type / source values and the notification type are mirrored.
//
// Wording of the email lives in the "Client Message" email_templates row; a
// missing/inactive row falls back to the copy below rather than going quiet.

import { createHmac, timingSafeEqual } from "crypto";
import supabaseAdmin from "./supabaseAdmin";
import { sendEmail } from "./email/emailTransport";
import { logger } from "./logger";
import { maskEmail } from "./maskEmail";
import { normalizeRecipientEmail } from "./emailIdentity";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
import { CLIENT_MESSAGE_TYPE } from "./notificationTypes";
import { pingInbox, pingReadByStaff, pingVisibleMessage } from "./chatRealtime";
import { handoverEventText, recordHandover, type HandoverHow } from "./chatHandlers";
import {
  decodeTemplateBraces,
  escapeHtml,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";

export const CLIENT_MESSAGE_TEMPLATE_NAME = "Client Message";
export const MAX_MESSAGE_LENGTH = 5000;

export type MessageKind = "message" | "note" | "event";

export type ThreadMessage = {
  id: string;
  kind: MessageKind;
  sender_type: "admin" | "client" | "system";
  sender_name: string | null;
  body: string;
  source: "portal" | "email";
  created_at: string;
  read_by_client_at: string | null;
};

export type Conversation = {
  root_lead_id: string;
  status: "open" | "resolved";
  assignee_email: string | null;
  assignee_name: string | null;
  rating: number | null;
  rating_comment: string | null;
  last_message_at: string;
};

const MESSAGE_COLS =
  "id, kind, sender_type, sender_name, body, source, created_at, read_by_client_at";
const CONVERSATION_COLS =
  "root_lead_id, status, assignee_email, assignee_name, rating, rating_comment, last_message_at";

function portalMessagesUrl(): string {
  let base = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").trim() || "https://www.iclosed.ca";
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  return `${base.replace(/\/+$/, "")}/dashboard?chat=1`;
}

/* ───────────────────────────── file / family lookups ─────────────────────── */

export async function rootLeadOfDeal(dealId: string): Promise<string | null> {
  const { data: deal } = await supabaseAdmin.from("deals").select("lead_id").eq("id", dealId).maybeSingle();
  if (!deal?.lead_id) return null;
  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .maybeSingle();
  return lead ? (lead.parent_lead_id ?? lead.id) : null;
}

/** Every non-deleted deal in the family, newest first (the root lead's own deal first). */
export async function familyDeals(rootLeadId: string) {
  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);
  const leadIds = (leads ?? []).map((l) => l.id);
  if (leadIds.length === 0) return [];
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, client_id, file_number, type, status, property_address, closing_date, created_at")
    .in("lead_id", leadIds)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });
  const list = deals ?? [];
  return [...list.filter((d) => d.lead_id === rootLeadId), ...list.filter((d) => d.lead_id !== rootLeadId)];
}

/* ───────────────────────── reply-by-email address ───────────────────────── */

function replySecret(): string {
  return process.env.MESSAGE_REPLY_SECRET || process.env.SERVICE_WEBHOOK_SECRET || "";
}

function sign(hex: string): string {
  return createHmac("sha256", replySecret()).update(`deal-message:${hex}`).digest("hex").slice(0, 12);
}

/**
 * Reply-To address for this file's message emails, or null when inbound email
 * is not configured (INBOUND_EMAIL_DOMAIN unset) — then the firm's normal
 * reply-to stays and the email simply points the client at the portal.
 * The local part carries the ROOT LEAD id plus an HMAC so it cannot be guessed.
 */
export function replyAddressForConversation(rootLeadId: string): string | null {
  const domain = (process.env.INBOUND_EMAIL_DOMAIN ?? "").trim().replace(/^@/, "");
  if (!domain || !replySecret()) return null;
  const hex = rootLeadId.replace(/-/g, "").toLowerCase();
  return `m${hex}.${sign(hex)}@${domain}`;
}

/** Inverse of replyAddressForConversation: the root lead id if the address is genuine. */
export function rootLeadFromReplyAddress(address: string): string | null {
  const m = /(?:^|[<\s])m([0-9a-f]{32})\.([0-9a-f]{12})@/i.exec(address.trim());
  if (!m || !replySecret()) return null;
  const hex = m[1].toLowerCase();
  const given = Buffer.from(m[2].toLowerCase());
  const want = Buffer.from(sign(hex));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ───────────────────────────── conversation state ────────────────────────── */

export async function ensureConversation(rootLeadId: string): Promise<void> {
  await supabaseAdmin
    .from("deal_conversations")
    .upsert({ root_lead_id: rootLeadId }, { onConflict: "root_lead_id", ignoreDuplicates: true });
}

export async function getConversation(rootLeadId: string): Promise<Conversation | null> {
  const { data } = await supabaseAdmin
    .from("deal_conversations")
    .select(CONVERSATION_COLS)
    .eq("root_lead_id", rootLeadId)
    .maybeSingle();
  return (data as Conversation | null) ?? null;
}

async function insertRow(row: {
  rootLeadId: string;
  dealId: string;
  kind: MessageKind;
  senderType: "admin" | "client" | "system";
  senderName?: string | null;
  senderEmail?: string | null;
  senderClientId?: string | null;
  body: string;
  source?: "portal" | "email";
  emailMessageId?: string | null;
  visibleToClient: boolean;
  readByAdmin?: boolean;
  readByClient?: boolean;
}) {
  const now = new Date().toISOString();
  return supabaseAdmin
    .from("deal_messages")
    .insert({
      root_lead_id: row.rootLeadId,
      deal_id: row.dealId,
      kind: row.kind,
      sender_type: row.senderType,
      sender_name: row.senderName ?? null,
      sender_email: row.senderEmail ?? null,
      sender_client_id: row.senderClientId ?? null,
      body: row.body,
      source: row.source ?? "portal",
      email_message_id: row.emailMessageId ?? null,
      visible_to_client: row.visibleToClient,
      read_by_admin_at: row.readByAdmin ? now : null,
      read_by_client_at: row.readByClient ? now : null,
    })
    .select(MESSAGE_COLS)
    .single();
}

export async function addEvent(
  rootLeadId: string,
  dealId: string,
  text: string,
  visibleToClient = false,
): Promise<void> {
  await insertRow({
    rootLeadId,
    dealId,
    kind: "event",
    senderType: "system",
    body: text,
    visibleToClient,
    readByAdmin: true,
    readByClient: true,
  });
}

export type Actor = { email: string | null; name: string };

/**
 * Change who HANDLES the file's chat (null = nobody). The thread itself stays
 * with the file, so the new handler sees all of it. Writes an internal
 * "Handed over from … to …" line and the handler history.
 */
export async function setAssignee(
  rootLeadId: string,
  assignee: { email: string; name: string } | null,
  by: Actor,
  how: HandoverHow = "manual",
): Promise<void> {
  await ensureConversation(rootLeadId);
  const before = await getConversation(rootLeadId);
  const prev = before?.assignee_email ? { email: before.assignee_email, name: before.assignee_name || before.assignee_email } : null;
  await supabaseAdmin
    .from("deal_conversations")
    .update({ assignee_email: assignee?.email ?? null, assignee_name: assignee?.name ?? null })
    .eq("root_lead_id", rootLeadId);
  const text = handoverEventText(prev, assignee, { by: by.email ? { email: by.email, name: by.name } : null, how });
  if (text) {
    const deals = await familyDeals(rootLeadId);
    if (deals[0]) await addEvent(rootLeadId, deals[0].id, text);
    await recordHandover(rootLeadId, assignee);
  }
  await pingInbox(rootLeadId);
}

/**
 * Someone is leaving (or swapping work): every file chat handled by `from`
 * moves to `to` — open and resolved alike, so a later client message reaches
 * the new handler. Each file gets its own handover line. Returns how many moved.
 */
export async function handoverAll(from: string, to: { email: string; name: string }, by: Actor): Promise<number> {
  const { data } = await supabaseAdmin
    .from("deal_conversations")
    .select("root_lead_id, assignee_email")
    .not("assignee_email", "is", null);
  const key = from.trim().toLowerCase();
  const roots = (data ?? [])
    .filter((c) => (c.assignee_email ?? "").toLowerCase() === key)
    .map((c) => c.root_lead_id as string);
  for (const root of roots) await setAssignee(root, to, by, "bulk");
  return roots.length;
}

/** Resolve / reopen. Both write an internal event (not shown to the client). */
export async function setStatus(rootLeadId: string, status: "open" | "resolved", by: Actor): Promise<void> {
  await ensureConversation(rootLeadId);
  await supabaseAdmin
    .from("deal_conversations")
    .update({ status, resolved_at: status === "resolved" ? new Date().toISOString() : null })
    .eq("root_lead_id", rootLeadId);
  const deals = await familyDeals(rootLeadId);
  if (deals[0]) {
    await addEvent(rootLeadId, deals[0].id, status === "resolved" ? `Resolved by ${by.name}` : `Reopened by ${by.name}`);
  }
  await pingInbox(rootLeadId);
}

/* ─────────────────────────────── thread I/O ─────────────────────────────── */

export async function loadThread(rootLeadId: string): Promise<ThreadMessage[]> {
  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .select(MESSAGE_COLS)
    .eq("root_lead_id", rootLeadId)
    .order("created_at", { ascending: true })
    .limit(1000);
  if (error) throw new Error(error.message);
  return (data ?? []) as ThreadMessage[];
}

/**
 * Stamp the client's messages as seen by staff. When anything was newly
 * stamped, the client's "Delivered" flips to "Seen" (and the inbox badges drop)
 * without waiting for a poll.
 */
export async function markClientMessagesRead(rootLeadId: string): Promise<number> {
  const { data } = await supabaseAdmin
    .from("deal_messages")
    .update({ read_by_admin_at: new Date().toISOString() })
    .eq("root_lead_id", rootLeadId)
    .eq("sender_type", "client")
    .is("read_by_admin_at", null)
    .select("id");
  const n = data?.length ?? 0;
  if (n > 0) await pingReadByStaff(rootLeadId);
  return n;
}

/* ─────────────────────────────── staff -> client ─────────────────────────── */

function bodyToHtml(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, "<br>");
}

function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

function fallbackBody(v: Record<string, string>): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi ${v.client_name},</p>
  <p>${v.sender_name} sent you a message about your file:</p>
  <blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #e11d48;background:#f8fafc;">${v.message_body}</blockquote>
  <p>You can simply <strong>reply to this email</strong>, or log in to your portal to respond.</p>
  <p style="margin-top:24px;"><a href="${v.portal_url}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">Open my messages</a></p>
</div>`;
}

export type SendMessageResult =
  | { ok: true; message: ThreadMessage; emailed: string[]; emailError?: string }
  | { ok: false; error: string };

/**
 * Save a staff reply (or private note) on the file's conversation.
 *
 * A REPLY is emailed to everyone on the file; the message is saved FIRST so a
 * refused email never loses what staff wrote. A NOTE is stored only — never
 * emailed, never visible to the client. A reply on an unassigned conversation
 * assigns it to the sender, and on a resolved one reopens it (as the design's
 * inbox does).
 */
export async function sendAdminMessage(opts: {
  rootLeadId: string;
  body: string;
  kind: "message" | "note";
  sender: { name: string; email: string | null };
}): Promise<SendMessageResult> {
  const text = opts.body.trim();
  if (!text) return { ok: false, error: "Message is empty." };
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).` };
  }

  const deals = await familyDeals(opts.rootLeadId);
  const deal = deals[0];
  if (!deal) return { ok: false, error: "This file has no deal to message about." };

  await ensureConversation(opts.rootLeadId);
  const isNote = opts.kind === "note";

  const { data: row, error } = await insertRow({
    rootLeadId: opts.rootLeadId,
    dealId: deal.id,
    kind: opts.kind,
    senderType: "admin",
    senderName: opts.sender.name,
    senderEmail: opts.sender.email,
    body: text,
    visibleToClient: !isNote,
    readByAdmin: true,
    readByClient: isNote,
  });
  if (error || !row) {
    logger.error("[DealMessages] insert failed:", error?.message);
    return { ok: false, error: "Could not save the message." };
  }
  const message = row as ThreadMessage;

  if (isNote) {
    await pingInbox(opts.rootLeadId);
    return { ok: true, message, emailed: [] };
  }

  // Conversation bookkeeping: bump, auto-assign, auto-reopen.
  const conv = await getConversation(opts.rootLeadId);
  const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
  if (conv && !conv.assignee_email && opts.sender.email) {
    patch.assignee_email = opts.sender.email;
    patch.assignee_name = opts.sender.name;
    const me = { email: opts.sender.email, name: opts.sender.name };
    await addEvent(opts.rootLeadId, deal.id, handoverEventText(null, me, { how: "first-reply" })!);
    await recordHandover(opts.rootLeadId, me);
  }
  if (conv?.status === "resolved") {
    patch.status = "open";
    patch.resolved_at = null;
    await addEvent(opts.rootLeadId, deal.id, `Reopened by ${opts.sender.name}`);
  }
  await supabaseAdmin.from("deal_conversations").update(patch).eq("root_lead_id", opts.rootLeadId);

  // Recipients: every client on the family's deals.
  const clientIds = [...new Set(deals.map((d) => d.client_id).filter(Boolean))] as string[];

  // Live first, email second: an open widget shows the reply before the email
  // round-trip finishes.
  await pingVisibleMessage(opts.rootLeadId, clientIds);
  const { data: clients } = clientIds.length
    ? await supabaseAdmin.from("clients").select("id, first_name, email").in("id", clientIds)
    : { data: [] };
  const people = (clients ?? []).filter((c) => (c.email ?? "").trim());
  if (people.length === 0) {
    return { ok: true, message, emailed: [], emailError: "No client on this file has an email address." };
  }

  const to = [...new Set(people.map((p) => normalizeRecipientEmail(p.email as string)))];
  const names = joinNames(people.map((p) => p.first_name ?? ""));
  const values: Record<string, TemplateValue> = {
    client_name: { value: names },
    first_name: { value: names },
    "user.first_name": { value: names },
    sender_name: { value: opts.sender.name },
    message_body: { value: bodyToHtml(text), raw: true },
    portal_url: { value: portalMessagesUrl() },
    file_number: { value: deal.file_number ?? "" },
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  };

  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${CLIENT_MESSAGE_TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });
  const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted && t.body);

  const html = template
    ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
    : fallbackBody({
        client_name: escapeHtml(names),
        sender_name: escapeHtml(opts.sender.name),
        message_body: values.message_body.value,
        portal_url: escapeHtml(values.portal_url.value),
      });
  const subject = renderTemplateSafe(
    decodeTemplateBraces(
      template?.subject || "New message from your iClosed team (File {{ file_number }})",
    ),
    resolve,
    { escape: false },
  );

  const firm = await getLeadFirmKey(opts.rootLeadId);
  const replyTo = replyAddressForConversation(opts.rootLeadId);
  const result = await sendEmail(
    { to, subject, html: brandEmailHtml(html, firm) },
    { firm, label: "client-message", ...(replyTo ? { replyTo } : {}) },
  );
  if (!result.ok) {
    logger.error(`[DealMessages] email failed for ${to.length} recipient(s): ${result.error}`);
    return { ok: true, message, emailed: [], emailError: result.error };
  }
  logger.info(`[DealMessages] emailed ${to.map(maskEmail).join(", ")}, id=${result.id}`);
  return { ok: true, message, emailed: to };
}

/* ─────────────────────────────── client -> staff ─────────────────────────── */

/**
 * Raise the bell for a client message. Idempotent per message id, so the
 * portal webhook and the email ingest can both call it freely.
 */
export async function notifyAdminsOfClientMessage(messageId: string): Promise<boolean> {
  try {
    const { data: msg } = await supabaseAdmin
      .from("deal_messages")
      .select("id, root_lead_id, deal_id, sender_name, body, source, sender_type, kind")
      .eq("id", messageId)
      .maybeSingle();
    if (!msg || msg.sender_type !== "client" || msg.kind !== "message") return false;

    const { data: existing } = await supabaseAdmin
      .from("notifications")
      .select("id")
      .eq("type", CLIENT_MESSAGE_TYPE)
      .contains("metadata", { message_id: msg.id })
      .limit(1);
    if (existing && existing.length > 0) return false;

    // A client writing again reopens a resolved conversation.
    await ensureConversation(msg.root_lead_id);
    await supabaseAdmin
      .from("deal_conversations")
      .update({ status: "open", resolved_at: null, last_message_at: new Date().toISOString() })
      .eq("root_lead_id", msg.root_lead_id)
      .eq("status", "resolved");

    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id, file_number")
      .eq("id", msg.deal_id)
      .maybeSingle();

    const who = msg.sender_name?.trim() || "A client";
    const preview = msg.body.length > 140 ? `${msg.body.slice(0, 137)}…` : msg.body;
    const { error } = await supabaseAdmin.from("notifications").insert({
      type: CLIENT_MESSAGE_TYPE,
      title: `${who} sent you a message${deal?.file_number ? ` (File ${deal.file_number})` : ""}.`,
      body: preview,
      deal_id: msg.deal_id,
      lead_id: msg.root_lead_id,
      file_number: deal?.file_number ?? null,
      metadata: { message_id: msg.id, source: msg.source },
    });
    if (error) {
      logger.error("[DealMessages] notification insert failed:", error.message);
      return false;
    }
    await pingInbox(msg.root_lead_id);
    return true;
  } catch (err) {
    logger.error("[DealMessages] notify failed:", err);
    return false;
  }
}

/** Drop the quoted history and signature a mail client appends to a reply. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    const next = (lines[i + 1] ?? "").trim();
    if (t.startsWith(">")) break;
    if (/^on .+wrote:?$/i.test(t)) break;
    if (/^on .+,$/i.test(t) && /wrote:?$/i.test(next)) break;
    if (/^-{2,}\s*(original message|forwarded message)/i.test(t)) break;
    if (/^_{5,}$/.test(t)) break;
    if (/^from:\s.+/i.test(t) && /^(sent|date|to):/i.test(next)) break;
    if (t === "--") break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export type InboundEmail = {
  to: string[];
  from: string;
  fromName?: string | null;
  text: string;
  messageId?: string | null;
};

/**
 * Turn a client's emailed reply into a thread message. The reply address
 * identifies the file; the sender must be one of the file's clients, otherwise
 * the mail is dropped (a forwarded address can't be used to post into a file).
 */
export async function ingestInboundEmail(
  mail: InboundEmail,
): Promise<{ stored: boolean; reason?: string }> {
  let rootLeadId: string | null = null;
  for (const addr of mail.to) {
    rootLeadId = rootLeadFromReplyAddress(addr);
    if (rootLeadId) break;
  }
  if (!rootLeadId) return { stored: false, reason: "unrecognised_address" };

  const body = stripQuotedReply(mail.text).slice(0, MAX_MESSAGE_LENGTH);
  if (!body) return { stored: false, reason: "empty" };

  if (mail.messageId) {
    const { data: dup } = await supabaseAdmin
      .from("deal_messages")
      .select("id")
      .eq("email_message_id", mail.messageId)
      .limit(1);
    if (dup && dup.length > 0) return { stored: false, reason: "duplicate" };
  }

  const sender = normalizeRecipientEmail(mail.from);
  const deals = await familyDeals(rootLeadId);
  if (deals.length === 0) return { stored: false, reason: "no_deal" };
  const clientIds = [...new Set(deals.map((d) => d.client_id).filter(Boolean))] as string[];
  const { data: clients } = clientIds.length
    ? await supabaseAdmin.from("clients").select("id, first_name, last_name, email").in("id", clientIds)
    : { data: [] };
  const match = (clients ?? []).find((c) => normalizeRecipientEmail(c.email) === sender);
  if (!match) return { stored: false, reason: "sender_not_on_file" };

  await ensureConversation(rootLeadId);
  const ownDeal = deals.find((d) => d.client_id === match.id) ?? deals[0];
  const name = `${match.first_name ?? ""} ${match.last_name ?? ""}`.trim() || mail.fromName || sender;

  const { data: row, error } = await insertRow({
    rootLeadId,
    dealId: ownDeal.id,
    kind: "message",
    senderType: "client",
    senderName: name,
    senderEmail: sender,
    senderClientId: match.id,
    body,
    source: "email",
    emailMessageId: mail.messageId ?? null,
    visibleToClient: true,
    readByClient: true,
  });
  if (error || !row) {
    if (error?.code === "23505") return { stored: false, reason: "duplicate" };
    logger.error("[DealMessages] inbound insert failed:", error?.message);
    return { stored: false, reason: "error" };
  }
  // Co-clients with the portal open see the emailed reply in their thread.
  await pingVisibleMessage(rootLeadId, clientIds);
  await notifyAdminsOfClientMessage(row.id);
  return { stored: true };
}
