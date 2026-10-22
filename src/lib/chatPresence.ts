// Staff Online / Away for the client chat, and client presence on a file.
//
// staff_presence (migrations/2026-10-22-chat-presence.sql): one row per staff
// email. Every admin tab of a staff member with the Messages module sends a
// heartbeat (POST /api/admin/messages/presence) every HEARTBEAT_MS; a row whose
// last_seen_at is older than STALE_MS — or that the last closing tab marked
// 'offline' — counts as offline. `manual_status` is the staff member's own pick
// from the sidebar menu and outlives reloads; `status` is what the last
// heartbeat computed (manual Away, or auto-Away after inactivity).
//
// The portal only ever learns ONE boolean: is anyone online. It computes that
// from the same table with the same thresholds (iclosed_dev_web/src/lib/chatPresence.ts,
// MIRRORED). Every reader here tolerates the migration not being applied yet:
// presence then reads as "unknown" and the chat behaves as before.

import supabaseAdmin from "./supabaseAdmin.ts";
import { logger } from "./logger.ts";
import { pingAvailability, pingInbox } from "./chatRealtime.ts";

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
/** Client presence rides the widget's 60 s safety poll; allow for one miss. */
export const CLIENT_STALE_MS = 150_000;

export type StaffStatus = "online" | "away" | "offline";

type PresenceRow = {
  staff_email: string;
  manual_status: "online" | "away";
  status: StaffStatus;
  last_seen_at: string;
};

/** Effective status: a stale heartbeat is offline whatever the row says. */
export function effectiveStatus(
  row: Pick<PresenceRow, "status" | "last_seen_at"> | null | undefined,
  now = Date.now(),
): StaffStatus {
  if (!row) return "offline";
  const seen = new Date(row.last_seen_at).getTime();
  if (!Number.isFinite(seen) || now - seen > STALE_MS) return "offline";
  return row.status;
}

/** Client on the file has the portal open: flagged online AND seen recently. */
export function clientIsOnline(
  conv: { client_online?: boolean | null; client_last_seen_at?: string | null } | null | undefined,
  now = Date.now(),
): boolean {
  if (!conv?.client_online || !conv.client_last_seen_at) return false;
  const seen = new Date(conv.client_last_seen_at).getTime();
  return Number.isFinite(seen) && now - seen <= CLIENT_STALE_MS;
}

/** Every staff row, or null when the table is missing / unreadable. */
export async function loadStaffPresence(): Promise<PresenceRow[] | null> {
  const { data, error } = await supabaseAdmin
    .from("staff_presence")
    .select("staff_email, manual_status, status, last_seen_at");
  if (error) {
    logger.warn("[chatPresence] staff_presence unreadable:", error.message);
    return null;
  }
  return (data ?? []) as PresenceRow[];
}

export function teamOnline(rows: PresenceRow[], now = Date.now()): boolean {
  return rows.some((r) => effectiveStatus(r, now) === "online");
}

/**
 * Record a heartbeat / status change for one staff member. Returns the row as
 * stored, or null if the table is missing. Broadcasts when this changed
 * whether the team as a whole is online (portal headers) or this person's
 * status (assign menus).
 */
export async function recordStaffPresence(
  email: string,
  input: { manual?: "online" | "away"; autoAway?: boolean; offline?: boolean },
): Promise<{ manual: "online" | "away"; status: StaffStatus } | null> {
  const key = email.trim().toLowerCase();
  const before = await loadStaffPresence();
  if (!before) return null;
  const prev = before.find((r) => r.staff_email === key) ?? null;

  const manual = input.manual ?? prev?.manual_status ?? "online";
  const status: StaffStatus = input.offline ? "offline" : manual === "away" || input.autoAway ? "away" : "online";
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin.from("staff_presence").upsert(
    { staff_email: key, manual_status: manual, status, last_seen_at: now, updated_at: now },
    { onConflict: "staff_email" },
  );
  if (error) {
    logger.warn("[chatPresence] heartbeat write failed:", error.message);
    return null;
  }

  const wasStatus = effectiveStatus(prev);
  if (wasStatus !== status) {
    const after = before.filter((r) => r.staff_email !== key).concat({
      staff_email: key,
      manual_status: manual,
      status,
      last_seen_at: now,
    });
    const wasOnline = teamOnline(before);
    const isOnline = teamOnline(after);
    await Promise.all([
      pingInbox("", "staff"),
      wasOnline !== isOnline ? pingAvailability(isOnline) : Promise.resolve(false),
    ]);
  }
  return { manual, status };
}
