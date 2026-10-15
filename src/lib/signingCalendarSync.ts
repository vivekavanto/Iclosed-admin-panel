// Keeps signing_appointments in step with the lawyers' Google Calendars.
//
// Reception or a lawyer may cancel a signing straight from Google Calendar
// instead of from the admin list. Google tells us nothing when that happens, so
// this looks at every upcoming confirmed appointment's event and, when the event
// is gone or cancelled, marks the row cancelled — exactly what the admin cancel
// button does (the slot frees up, the client's "Book your signing appointment"
// task reopens, the portal stops showing the booking and lets them rebook).
//
// Google already emails the client when the event is cancelled there, so no
// email is sent from here. Only the "confirmed" -> "cancelled" direction is
// handled: an unreachable calendar ("unknown") never cancels anything.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getCalendarEventState } from "./googleCalendar";
import { reopenSigningTask } from "./reopenSigningTask";

const MAX_PER_RUN = 200;
const CONCURRENCY = 5;
// The admin list triggers a sync on every load; don't hit Google more than this often.
const MIN_INTERVAL_MS = 30_000;
let lastRunAt = 0;

export interface CalendarSyncResult {
  checked: number;
  cancelled: number;
}

export async function syncCancelledFromCalendar(
  opts: { throttle?: boolean } = {},
): Promise<CalendarSyncResult> {
  const result: CalendarSyncResult = { checked: 0, cancelled: 0 };
  if (opts.throttle) {
    if (Date.now() - lastRunAt < MIN_INTERVAL_MS) return result;
    lastRunAt = Date.now();
  }

  const { data: appts, error } = await supabaseAdmin
    .from("signing_appointments")
    .select("id, deal_id, side, google_event_id, lawyer:signing_lawyers(email, calendar_id)")
    .eq("status", "confirmed")
    .not("google_event_id", "is", null)
    .gt("end_at", new Date().toISOString())
    .order("start_at", { ascending: true })
    .limit(MAX_PER_RUN);
  if (error) {
    logger.error("[SigningCalendarSync] query failed:", error.message);
    return result;
  }

  const rows = (appts ?? []) as unknown as Array<{
    id: string;
    deal_id: string | null;
    side: string | null;
    google_event_id: string;
    lawyer: { email: string; calendar_id: string | null } | null;
  }>;

  async function check(appt: (typeof rows)[number]) {
    if (!appt.lawyer?.email) return;
    result.checked += 1;
    const state = await getCalendarEventState(
      appt.lawyer.email,
      appt.lawyer.calendar_id ?? "primary",
      appt.google_event_id,
    );
    if (state !== "cancelled") return;

    // Conditional on status so a concurrent admin cancel (or a second runner)
    // only wins once, and the task is only reopened once.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("signing_appointments")
      .update({ status: "cancelled" })
      .eq("id", appt.id)
      .eq("status", "confirmed")
      .select("id, deal_id, side");
    if (updateError) {
      logger.error("[SigningCalendarSync] update failed:", updateError.message, { id: appt.id });
      return;
    }
    if (!updated || updated.length === 0) return;

    result.cancelled += 1;
    logger.info("[SigningCalendarSync] cancelled from Google Calendar", { id: appt.id });
    await reopenSigningTask(updated[0]);
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(
      rows.slice(i, i + CONCURRENCY).map((a) =>
        check(a).catch((err) => logger.error("[SigningCalendarSync] check failed:", err, { id: a.id })),
      ),
    );
  }
  return result;
}
