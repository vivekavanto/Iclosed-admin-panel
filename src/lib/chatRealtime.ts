// Realtime "ping + refetch" for the client chat (docs/chat-realtime-implementation-plan.md).
//
// After a write, the server broadcasts a SMALL ping on a Supabase Realtime
// Broadcast channel; subscribed browsers then refetch through the same
// authorised API they already poll. Payloads never carry message text, so a
// leaked channel name reveals only that "something happened".
//
// Always on — there is no switch. Channel names are HMACs of the id under the
// secret the two apps ALREADY share, SERVICE_WEBHOOK_SECRET (CHAT_REALTIME_SECRET
// overrides it if ever set), so they cannot be derived from a lead / client id
// and no new variable is needed. It must be the SAME in the admin and the portal
// (both compute names) and DIFFERENT per environment: dev, preview and prod
// share one Supabase project, and the secret is what keeps their channels
// apart. With no usable secret nothing is broadcast and the chat falls back to
// polling, exactly as it worked before realtime.
//
// MIRRORED in the portal: iclosed_dev_web/src/lib/chatRealtime.ts. Channel
// prefixes, event names and the HMAC input must stay identical in both.
//
// Server-only (reads the service-role key). Everything here is best-effort: a
// failed ping must never fail the write that triggered it.

import { createHmac } from "crypto";
import { logger } from "./logger.ts";

export type ChannelKind = "chat" | "inbox" | "client" | "avail";

export type ChatChannels = {
  /** Staff: every conversation change, typing and presence, each with { root }. */
  inbox?: string;
  /** Clients on one file: message / read / typing. */
  chat?: string;
  /** One client, every page: unread badge. */
  client?: string;
  /** Every client: team availability. */
  avail?: string;
};

function secret(): string {
  return (process.env.CHAT_REALTIME_SECRET || process.env.SERVICE_WEBHOOK_SECRET || "").trim();
}

/** Realtime runs whenever the server can name channels (a usable shared secret exists). */
export function realtimeEnabled(): boolean {
  return secret().length >= 16;
}

function envPrefix(): string {
  const raw = (process.env.CHAT_REALTIME_ENV ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return raw ? `${raw}:` : "";
}

/** Deterministic channel name; pure given the secret, exported for tests. */
export function channelNameWith(key: string, kind: ChannelKind, id = ""): string {
  const h = createHmac("sha256", key).update(`chat-realtime:${kind}:${id}`).digest("hex").slice(0, 32);
  return `${kind}:${h}`;
}

/** The channel's name, or null when realtime is off. */
export function channelName(kind: ChannelKind, id = ""): string | null {
  if (!realtimeEnabled()) return null;
  return `${envPrefix()}${channelNameWith(secret(), kind, id)}`;
}

export type Ping = { channel: string | null; event: string; payload?: Record<string, unknown> };

/**
 * Send pings through the Realtime REST broadcast endpoint (one HTTP call for
 * all of them). Never throws; resolves false on any failure.
 */
export async function broadcast(pings: Ping[]): Promise<boolean> {
  const list = pings.filter((p): p is Ping & { channel: string } => !!p.channel);
  if (list.length === 0) return false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: list.map((p) => ({ topic: p.channel, event: p.event, payload: p.payload ?? {}, private: false })),
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      logger.warn(`[chatRealtime] broadcast returned ${res.status}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("[chatRealtime] broadcast failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/* ───────────────────────── the pings each write sends ───────────────────────── */

/** Something changed on a conversation that only staff need to know about. */
export function pingInbox(rootLeadId: string, event = "changed", extra?: Record<string, unknown>) {
  return broadcast([{ channel: channelName("inbox"), event, payload: { root: rootLeadId, ...extra } }]);
}

/**
 * A message the CLIENTS can see was added (staff reply, client message, email
 * reply, ended conversation): refresh the thread for everyone on the file, the
 * inbox for staff, and the launcher badge of each client in `clientIds`.
 */
export function pingVisibleMessage(rootLeadId: string, clientIds: string[] = []) {
  return broadcast([
    { channel: channelName("chat", rootLeadId), event: "message" },
    { channel: channelName("inbox"), event: "changed", payload: { root: rootLeadId } },
    ...[...new Set(clientIds)].map((id) => ({ channel: channelName("client", id), event: "message" })),
  ]);
}

/** Staff opened the thread: the client's "Delivered" flips to "Seen". */
export function pingReadByStaff(rootLeadId: string) {
  return broadcast([
    { channel: channelName("chat", rootLeadId), event: "read" },
    { channel: channelName("inbox"), event: "changed", payload: { root: rootLeadId } },
  ]);
}

/** Staff typing in a thread: three dots in the client's widget. */
export function pingStaffTyping(rootLeadId: string) {
  return broadcast([{ channel: channelName("chat", rootLeadId), event: "typing", payload: { role: "staff" } }]);
}

/** Team availability changed: every widget header. */
export function pingAvailability(online: boolean) {
  return broadcast([{ channel: channelName("avail"), event: "availability", payload: { online } }]);
}

/** Channels a staff browser listens on. */
export function staffChannels(): ChatChannels {
  const inbox = channelName("inbox");
  return inbox ? { inbox } : {};
}
