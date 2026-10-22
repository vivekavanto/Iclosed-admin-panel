// Who HANDLES a file's chat (the conversation itself belongs to the FILE).
//
// Like a parcel and its couriers: the order (the file's thread) never changes
// hands, only the person delivering it does, and whoever takes over sees the
// whole history. deal_conversations.assignee_* is the CURRENT handler; this
// module words the handover lines in the thread and keeps the history in
// deal_conversation_handlers (migrations/2026-10-22-chat-file-handlers.sql).
//
// History writes are best-effort and tolerate the table missing: a handover
// must never fail because its history row could not be written.

import supabaseAdmin from "./supabaseAdmin.ts";
import { logger } from "./logger.ts";

export type Person = { email: string; name: string };

/** How the handler changed — only changes the wording of the thread line. */
export type HandoverHow = "manual" | "first-reply" | "online" | "bulk";

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The internal thread line for a handler change, or null when nothing changed.
 * `by` is the staff member who made the change (absent for automatic ones).
 */
export function handoverEventText(
  prev: Person | null,
  next: Person | null,
  opts: { by?: Person | null; how?: HandoverHow } = {},
): string | null {
  const { by = null, how = "manual" } = opts;
  if (!prev && !next) return null;
  if (prev && next && same(prev.email, next.email)) return null;

  if (!prev && next) {
    if (how === "online") return `${next.name} is now handling this file (online)`;
    if (how === "first-reply" || !by || same(by.email, next.email)) return `${next.name} is now handling this file`;
    return `${next.name} is now handling this file (set by ${by.name})`;
  }
  if (prev && !next) {
    return by && !same(by.email, prev.email)
      ? `${prev.name} stopped handling this file (by ${by.name})`
      : `${prev.name} stopped handling this file`;
  }
  // prev && next, different people
  const base = `Handed over from ${prev!.name} to ${next!.name}`;
  if (how === "bulk") return by ? `${base} (all of ${prev!.name}'s files, moved by ${by.name})` : base;
  if (how === "online") return `${base} (online)`;
  return by && !same(by.email, next!.email) && !same(by.email, prev!.email) ? `${base} by ${by.name}` : base;
}

/** Close the current handler's stint and open the next one. Never throws. */
export async function recordHandover(rootLeadId: string, next: Person | null): Promise<void> {
  try {
    const now = new Date().toISOString();
    const { error } = await supabaseAdmin
      .from("deal_conversation_handlers")
      .update({ ended_at: now })
      .eq("root_lead_id", rootLeadId)
      .is("ended_at", null);
    if (error) {
      logger.warn("[chatHandlers] history unavailable:", error.message);
      return;
    }
    if (next) {
      await supabaseAdmin
        .from("deal_conversation_handlers")
        .insert({ root_lead_id: rootLeadId, staff_email: next.email, staff_name: next.name, started_at: now });
    }
  } catch (err) {
    logger.warn("[chatHandlers] history write failed:", err);
  }
}

export type HandlerStint = { name: string; email: string; started_at: string; ended_at: string | null };

/** Everyone who has handled this file's chat, oldest first; [] when unavailable. */
export async function loadHandlers(rootLeadId: string): Promise<HandlerStint[]> {
  const { data, error } = await supabaseAdmin
    .from("deal_conversation_handlers")
    .select("staff_email, staff_name, started_at, ended_at")
    .eq("root_lead_id", rootLeadId)
    .order("started_at", { ascending: true })
    .limit(50);
  if (error) return [];
  return (data ?? []).map((r) => ({
    email: r.staff_email as string,
    name: ((r.staff_name as string | null) ?? "").trim() || (r.staff_email as string),
    started_at: r.started_at as string,
    ended_at: (r.ended_at as string | null) ?? null,
  }));
}
