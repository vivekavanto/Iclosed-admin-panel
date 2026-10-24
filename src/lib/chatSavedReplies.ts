// The "/" saved replies in the staff chat composer (table chat_saved_replies,
// migrations/2026-10-23-chat-attachments-edits-saved-replies.sql).
//
// They used to be a constant in MessagesInbox.tsx, so changing one meant a
// deploy. Now staff manage them from the inbox. DEFAULT_SAVED_REPLIES is that
// old constant: the migration seeds the table with it, and the inbox falls back
// to it (read-only) while the table doesn't exist yet.
//
// `{name}` in a body is replaced in the composer with the client's first name.

import supabaseAdmin from "./supabaseAdmin";

export type SavedReply = {
  id: string;
  shortcut: string;
  title: string;
  body: string;
  sort_order: number;
};

export const DEFAULT_SAVED_REPLIES: SavedReply[] = [
  { id: "default-hi", shortcut: "/hi", title: "Greeting", body: "Hi {name}, thanks for reaching out! Give me a moment to look into this.", sort_order: 10 },
  { id: "default-docs", shortcut: "/docs", title: "Documents reminder", body: "Could you please upload the outstanding documents in your portal under Your Documents? Let me know if anything is unclear.", sort_order: 20 },
  { id: "default-tasks", shortcut: "/tasks", title: "Pending tasks", body: "A quick reminder to complete your pending tasks in the portal so we can keep your file moving.", sort_order: 30 },
  { id: "default-closing", shortcut: "/closing", title: "Closing date", body: "Your closing date is on track. I’ll let you know as soon as anything changes.", sort_order: 40 },
  { id: "default-handoff", shortcut: "/handoff", title: "Hand off", body: "I’m looping in a colleague who will reply right here in this chat.", sort_order: 50 },
  { id: "default-bye", shortcut: "/bye", title: "Close out", body: "Glad I could help! I’ll mark this as resolved. Just reply here if anything else comes up.", sort_order: 60 },
];

const COLS = "id, shortcut, title, body, sort_order";

/** Postgres / PostgREST codes for "that table isn't there" (migration not run). */
export function isMissingRelation(code: string | undefined): boolean {
  return code === "42P01" || code === "PGRST205";
}

/**
 * The replies, in display order. `editable` is false when the table is missing,
 * in which case the built-in list is returned so the composer keeps working.
 */
export async function listSavedReplies(): Promise<{ replies: SavedReply[]; editable: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("chat_saved_replies")
    .select(COLS)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingRelation(error.code)) return { replies: DEFAULT_SAVED_REPLIES, editable: false };
    throw new Error(error.message);
  }
  return { replies: (data ?? []) as SavedReply[], editable: true };
}

export type SavedReplyInput = { shortcut: string; title: string; body: string };

/** "/Docs Reminder" -> "/docs-reminder". Same rule as the table's CHECK. */
export function normalizeShortcut(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^\/+/, "").replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  return `/${s.slice(0, 30)}`;
}

/** Validate + clean one reply from a request body. */
export function parseSavedReply(input: unknown): { ok: true; value: SavedReplyInput } | { ok: false; error: string } {
  const p = (input ?? {}) as Record<string, unknown>;
  const shortcut = normalizeShortcut(typeof p.shortcut === "string" ? p.shortcut : "");
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body.trim() : "";
  if (shortcut === "/") return { ok: false, error: "Give the reply a shortcut, like /docs." };
  if (!title) return { ok: false, error: "Give the reply a title." };
  if (title.length > 80) return { ok: false, error: "The title is too long (max 80 characters)." };
  if (!body) return { ok: false, error: "The reply text is empty." };
  if (body.length > 5000) return { ok: false, error: "The reply is too long (max 5000 characters)." };
  return { ok: true, value: { shortcut, title, body } };
}
