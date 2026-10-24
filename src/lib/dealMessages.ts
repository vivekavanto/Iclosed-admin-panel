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
import { isBlobUrl } from "./blobPrivacy";
import { BlobDocumentError, readBlobMeta } from "./blobDocument";
import {
  CHAT_ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  chatAttachmentPrefix,
  parseAttachments,
  type ChatAttachment,
} from "./chatAttachments";

export const CLIENT_MESSAGE_TEMPLATE_NAME = "Client Message";
export const MAX_MESSAGE_LENGTH = 5000;

export type MessageKind = "message" | "note" | "event";

export type ThreadMessage = {
  id: string;
  kind: MessageKind;
  sender_type: "admin" | "client" | "system";
  sender_name: string | null;
  sender_email: string | null;
  body: string;
  source: "portal" | "email";
  created_at: string;
  read_by_client_at: string | null;
  attachments: ChatAttachment[];
  edited_at: string | null;
  deleted_at: string | null;
  /** The message this one answers (same thread), or null. */
  reply_to_id: string | null;
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

// Attachments / edit / delete columns arrive with
// migrations/2026-10-23-chat-attachments-edits-saved-replies.sql. Until it has
// run, selecting them fails with 42703 and every read would come back empty —
// so reads retry with the original columns and the chat works as before.
const LEGACY_MESSAGE_COLS =
  "id, kind, sender_type, sender_name, sender_email, body, source, created_at, read_by_client_at";
const V1_MESSAGE_COLS = `${LEGACY_MESSAGE_COLS}, attachments, edited_at, deleted_at`;
// reply_to_id comes with migrations/2026-10-23-chat-reply-to.sql.
const MESSAGE_COLS = `${V1_MESSAGE_COLS}, reply_to_id`;
/** Newest first: each read falls back a step when a migration hasn't run yet. */
const MESSAGE_COL_TIERS = [MESSAGE_COLS, V1_MESSAGE_COLS, LEGACY_MESSAGE_COLS];

/** Postgres "undefined column" (select) / PostgREST "column not in schema cache" (write). */
export function isMissingColumn(code: string | undefined): boolean {
  return code === "42703" || code === "PGRST204";
}

export const CHAT_MIGRATION_MISSING =
  "This needs the chat migration (2026-10-23-chat-attachments-edits-saved-replies.sql) to be run first.";

/** A row as the thread shows it. A deleted message keeps its row but loses its content. */
function toThreadMessage(row: Record<string, unknown>): ThreadMessage {
  const deleted = (row.deleted_at as string | null | undefined) ?? null;
  return {
    id: row.id as string,
    kind: row.kind as MessageKind,
    sender_type: row.sender_type as ThreadMessage["sender_type"],
    sender_name: (row.sender_name as string | null) ?? null,
    sender_email: (row.sender_email as string | null) ?? null,
    body: deleted ? "" : ((row.body as string) ?? ""),
    source: row.source as ThreadMessage["source"],
    created_at: row.created_at as string,
    read_by_client_at: (row.read_by_client_at as string | null) ?? null,
    attachments: deleted ? [] : parseAttachments(row.attachments),
    edited_at: (row.edited_at as string | null | undefined) ?? null,
    deleted_at: deleted,
    reply_to_id: (row.reply_to_id as string | null | undefined) ?? null,
  };
}

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
  attachments?: ChatAttachment[];
  /** Already checked with checkReplyTarget. */
  replyToId?: string | null;
}): Promise<{ data: ThreadMessage | null; error: { code?: string; message: string } | null }> {
  const now = new Date().toISOString();
  const attachments = row.attachments ?? [];
  const values: Record<string, unknown> = {
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
    // Only named when there is something to store, so a plain message still
    // inserts on a database the migration hasn't reached.
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(row.replyToId ? { reply_to_id: row.replyToId } : {}),
  };
  // Pre-migration a failed statement inserted nothing, so stepping down a tier
  // and retrying is safe. A reply quote is dropped rather than losing the
  // message; an attachment can't be stored without its column, so say so.
  let lastError: { code?: string; message: string } | null = null;
  for (const cols of MESSAGE_COL_TIERS) {
    const hasReply = cols.includes("reply_to_id");
    if (!cols.includes("attachments") && attachments.length > 0) {
      return { data: null, error: { code: lastError?.code, message: CHAT_MIGRATION_MISSING } };
    }
    const tierValues = { ...values };
    if (!hasReply) delete tierValues.reply_to_id;
    const res = await supabaseAdmin.from("deal_messages").insert(tierValues).select(cols).single();
    if (!res.error) return { data: toThreadMessage(res.data as unknown as Record<string, unknown>), error: null };
    if (!isMissingColumn(res.error.code)) return { data: null, error: res.error };
    lastError = res.error;
  }
  return { data: null, error: lastError };
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
  const run = (cols: string) =>
    supabaseAdmin
      .from("deal_messages")
      .select(cols)
      .eq("root_lead_id", rootLeadId)
      .order("created_at", { ascending: true })
      .limit(1000);
  for (const cols of MESSAGE_COL_TIERS) {
    const { data, error } = await run(cols);
    if (!error) return ((data ?? []) as unknown as Record<string, unknown>[]).map(toThreadMessage);
    if (!isMissingColumn(error.code)) throw new Error(error.message);
  }
  throw new Error("deal_messages is missing its base columns");
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

/**
 * Check the attachments a sender claims to have uploaded, against storage.
 * Each must be a blob under THIS file's chat prefix (so a URL from another
 * file — or any other document — can't be attached), exist, and be within the
 * size / type limits. Name comes from the request (what the user picked);
 * size and type come from storage, never from the request.
 */
export async function verifyChatAttachments(
  rootLeadId: string,
  input: unknown,
): Promise<{ ok: true; attachments: ChatAttachment[] } | { ok: false; error: string }> {
  if (input == null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: "Invalid attachments." };
  if (input.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return { ok: false, error: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.` };
  }
  const prefix = chatAttachmentPrefix(rootLeadId);
  const out: ChatAttachment[] = [];
  for (const raw of input) {
    const a = (raw ?? {}) as Record<string, unknown>;
    const url = typeof a.url === "string" ? a.url : "";
    if (!isBlobUrl(url)) return { ok: false, error: "Invalid attachment." };
    let meta;
    try {
      meta = await readBlobMeta(url);
    } catch (err) {
      if (err instanceof BlobDocumentError) return { ok: false, error: "An attachment could not be found. Please attach it again." };
      throw err;
    }
    if (!meta.pathname.startsWith(prefix)) return { ok: false, error: "Invalid attachment." };
    if (meta.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: "An attachment is larger than 10 MB." };
    if (!CHAT_ATTACHMENT_TYPES.includes(meta.contentType.split(";")[0].trim())) {
      return { ok: false, error: "An attachment has a file type that can't be sent." };
    }
    const name =
      (typeof a.name === "string" ? a.name : "").replace(/[\u0000-\u001f"\\]/g, "").trim().slice(0, 150) ||
      meta.pathname.split("/").pop() ||
      "file";
    if (out.some((x) => x.url === url)) continue;
    out.push({ url, name, size: meta.size, type: meta.contentType });
  }
  return { ok: true, attachments: out };
}

export type ReplyTarget = {
  id: string;
  sender_name: string | null;
  sender_type: string;
  body: string;
  attachments: ChatAttachment[];
  deleted: boolean;
};

/**
 * The message a new one quotes. It must be in the SAME thread and be a message
 * or note (never an event line). A client-visible reply may only quote a
 * client-visible message — quoting a private note would put its text in front
 * of the client (in the portal and in the email). Notes may quote anything.
 */
export async function checkReplyTarget(
  rootLeadId: string,
  replyToId: unknown,
  newIsVisibleToClient: boolean,
): Promise<{ ok: true; target: ReplyTarget | null } | { ok: false; error: string }> {
  if (replyToId == null || replyToId === "") return { ok: true, target: null };
  if (typeof replyToId !== "string" || !/^[0-9a-f-]{36}$/i.test(replyToId)) return { ok: false, error: "Invalid reply." };
  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .select("id, root_lead_id, kind, visible_to_client, sender_name, sender_type, body, attachments, deleted_at")
    .eq("id", replyToId)
    .maybeSingle();
  if (error) {
    // Columns not there yet: send without the quote rather than failing.
    if (isMissingColumn(error.code)) return { ok: true, target: null };
    throw new Error(error.message);
  }
  if (!data || data.root_lead_id !== rootLeadId || (data.kind !== "message" && data.kind !== "note")) {
    return { ok: false, error: "The message you replied to is no longer in this chat." };
  }
  if (newIsVisibleToClient && !data.visible_to_client) {
    return { ok: false, error: "A private note can't be quoted in a reply to the client." };
  }
  return {
    ok: true,
    target: {
      id: data.id,
      sender_name: data.sender_name,
      sender_type: data.sender_type,
      body: data.deleted_at ? "" : data.body ?? "",
      attachments: data.deleted_at ? [] : parseAttachments(data.attachments),
      deleted: !!data.deleted_at,
    },
  };
}

/** The "Replying to …" block above a reply in the notification email. */
function quoteToHtml(t: ReplyTarget | null): string {
  if (!t) return "";
  const who = t.sender_type === "client" ? "you" : t.sender_name || "our team";
  let text = t.deleted ? "This message was deleted" : t.body.trim() || (t.attachments.length ? `📎 ${t.attachments.map((a) => a.name).join(", ")}` : "");
  if (text.length > 200) text = `${text.slice(0, 197)}…`;
  return `<div style="margin:0 0 10px;padding:6px 10px;border-left:3px solid #cbd5e1;background:#f1f5f9;color:#475569;font-size:13px;">Replying to ${escapeHtml(who)}: ${escapeHtml(text).replace(/\r?\n/g, " ")}</div>`;
}

/** The "Attached: …" line under a message in the notification email. */
function attachmentsToHtml(list: ChatAttachment[], afterText: boolean): string {
  if (list.length === 0) return "";
  const names = list.map((a) => escapeHtml(a.name)).join(", ");
  return `${afterText ? "<br><br>" : ""}<span style="color:#475569;font-size:13px;">&#128206; Attached: ${names}<br>Open your portal to view ${list.length === 1 ? "it" : "them"}.</span>`;
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
  /** Already checked with verifyChatAttachments. */
  attachments?: ChatAttachment[];
  /** Already checked with checkReplyTarget (for this kind's visibility). */
  replyTo?: ReplyTarget | null;
}): Promise<SendMessageResult> {
  const text = opts.body.trim();
  const attachments = opts.attachments ?? [];
  if (!text && attachments.length === 0) return { ok: false, error: "Message is empty." };
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
    attachments,
    replyToId: opts.replyTo?.id ?? null,
  });
  if (error || !row) {
    logger.error("[DealMessages] insert failed:", error?.message);
    return { ok: false, error: error?.message === CHAT_MIGRATION_MISSING ? CHAT_MIGRATION_MISSING : "Could not save the message." };
  }
  const message = row;

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
    message_body: { value: quoteToHtml(opts.replyTo ?? null) + bodyToHtml(text) + attachmentsToHtml(attachments, !!text), raw: true },
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

/* ─────────────────────────── edit / delete (staff) ───────────────────────── */

export type ChangeMessageResult =
  | { ok: true; message: ThreadMessage }
  | { ok: false; error: string; status: number };

type OwnRow = {
  id: string;
  kind: MessageKind;
  sender_type: string;
  sender_email: string | null;
  body: string;
  original_body: string | null;
  attachments: unknown;
  visible_to_client: boolean;
  deleted_at: string | null;
};

/**
 * A staff member may change only their OWN replies and notes — never a
 * client's message, an event line, or a colleague's message. Matched on the
 * sender email the row was written with.
 */
async function loadOwnStaffMessage(
  rootLeadId: string,
  messageId: string,
  actorEmail: string | null,
): Promise<{ ok: true; row: OwnRow } | { ok: false; error: string; status: number }> {
  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .select("id, kind, sender_type, sender_email, body, original_body, attachments, visible_to_client, deleted_at")
    .eq("id", messageId)
    .eq("root_lead_id", rootLeadId)
    .maybeSingle();
  if (error) {
    if (isMissingColumn(error.code)) return { ok: false, error: CHAT_MIGRATION_MISSING, status: 409 };
    throw new Error(error.message);
  }
  const row = data as OwnRow | null;
  if (!row) return { ok: false, error: "Message not found.", status: 404 };
  const own =
    row.sender_type === "admin" &&
    (row.kind === "message" || row.kind === "note") &&
    !!actorEmail &&
    (row.sender_email ?? "").toLowerCase() === actorEmail.toLowerCase();
  if (!own) return { ok: false, error: "You can only change your own messages.", status: 403 };
  if (row.deleted_at) return { ok: false, error: "This message was already deleted.", status: 409 };
  return { ok: true, row };
}

/** Live refresh after a change: clients see it only if the row is theirs to see. */
async function pingChanged(rootLeadId: string, visibleToClient: boolean): Promise<void> {
  if (visibleToClient) await pingVisibleMessage(rootLeadId);
  else await pingInbox(rootLeadId);
}

/**
 * Edit a staff reply / note. The text as FIRST sent is kept in original_body
 * (it is what the client was emailed); the thread shows "edited". The email is
 * not re-sent.
 */
export async function editStaffMessage(opts: {
  rootLeadId: string;
  messageId: string;
  body: string;
  actor: Actor;
}): Promise<ChangeMessageResult> {
  const text = opts.body.trim();
  if (text.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, error: `Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`, status: 400 };
  }
  const found = await loadOwnStaffMessage(opts.rootLeadId, opts.messageId, opts.actor.email);
  if (!found.ok) return found;
  const { row } = found;
  if (!text && parseAttachments(row.attachments).length === 0) {
    return { ok: false, error: "Message is empty. Delete it instead.", status: 400 };
  }

  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .update({
      body: text,
      edited_at: new Date().toISOString(),
      original_body: row.original_body ?? row.body,
    })
    .eq("id", row.id)
    .select(V1_MESSAGE_COLS)
    .single();
  if (error || !data) {
    logger.error("[DealMessages] edit failed:", error?.message);
    return { ok: false, error: "Could not edit the message.", status: 500 };
  }
  await pingChanged(opts.rootLeadId, row.visible_to_client);
  return { ok: true, message: toThreadMessage(data as Record<string, unknown>) };
}

/**
 * Soft-delete a staff reply / note: the row stays (with its text, for the
 * record), but both apps show "This message was deleted" and stop serving its
 * attachments. An email already sent can't be recalled.
 */
export async function deleteStaffMessage(opts: {
  rootLeadId: string;
  messageId: string;
  actor: Actor;
}): Promise<ChangeMessageResult> {
  const found = await loadOwnStaffMessage(opts.rootLeadId, opts.messageId, opts.actor.email);
  if (!found.ok) return found;
  const { row } = found;

  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .update({ deleted_at: new Date().toISOString(), deleted_by: opts.actor.email })
    .eq("id", row.id)
    .select(V1_MESSAGE_COLS)
    .single();
  if (error || !data) {
    logger.error("[DealMessages] delete failed:", error?.message);
    return { ok: false, error: "Could not delete the message.", status: 500 };
  }
  await pingChanged(opts.rootLeadId, row.visible_to_client);
  return { ok: true, message: toThreadMessage(data as Record<string, unknown>) };
}

/* ───────────────────────────── attachment access ─────────────────────────── */

/**
 * The attachment with this URL, if it is on a live (not deleted) message in
 * this file's thread. Staff can see notes too, so no visibility filter here.
 */
export async function findThreadAttachment(rootLeadId: string, url: string): Promise<ChatAttachment | null> {
  const { data, error } = await supabaseAdmin
    .from("deal_messages")
    .select("attachments")
    .eq("root_lead_id", rootLeadId)
    .is("deleted_at", null)
    // JSON text on purpose: .contains() with a JS array sends a Postgres ARRAY
    // literal ({...}), which a jsonb column rejects with 22P02.
    .filter("attachments", "cs", JSON.stringify([{ url }]))
    .limit(1);
  if (error) {
    if (isMissingColumn(error.code)) return null;
    throw new Error(error.message);
  }
  const list = parseAttachments(data?.[0]?.attachments);
  return list.find((a) => a.url === url) ?? null;
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
    // An attachment-only message has an empty body.
    const text = msg.body.trim() || "Sent an attachment.";
    const preview = text.length > 140 ? `${text.slice(0, 137)}…` : text;
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
