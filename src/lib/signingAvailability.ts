// Availability computation for the signing-appointment booking system.
//
// For one lawyer and one office-local calendar date, combines:
//   1. signing_lawyer_hours (weekly template)       -> the open window
//   2. signing_blocked_times (lawyer-specific + global rows)
//   3. existing confirmed signing_appointments (occupying start..end+buffer)
//   4. the lawyer's real Google Calendar freebusy
// and returns bookable start times in slot_increment_minutes steps.
//
// Called both by the public booking page (read) and re-run server-side
// immediately before a booking/reschedule is committed, so a slot that went
// stale between page-load and submit is rejected rather than double-booked.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getFreeBusy } from "./googleCalendar";
import { getLawyerHours, getSettings, type SigningLawyer } from "./signingConfig";
import {
  OFFICE_TIMEZONE,
  dayOfWeekInTimeZone,
  parseDateOnly,
  parseTimeOfDay,
  zonedTimeToUtc,
} from "./signingTimezone";

export interface Interval {
  start: number; // epoch ms
  end: number; // epoch ms
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [sorted[0]];
  for (const cur of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Subtract `busy` (already merged) from a single `window`, in window order. */
function subtractFromWindow(window: Interval, busy: Interval[]): Interval[] {
  const free: Interval[] = [];
  let cursor = window.start;
  for (const b of busy) {
    if (b.end <= cursor || b.start >= window.end) continue;
    if (b.start > cursor) free.push({ start: cursor, end: Math.min(b.start, window.end) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= window.end) break;
  }
  if (cursor < window.end) free.push({ start: cursor, end: window.end });
  return free;
}

export interface AvailabilityResult {
  lawyer: SigningLawyer;
  date: string;
  durationMinutes: number;
  bufferMinutes: number;
  slotIncrementMinutes: number;
  /** Bookable start times, as UTC ISO strings. */
  slots: string[];
}

/**
 * Bookable start times for `lawyer` on office-local calendar date `dateOnly`
 * ("YYYY-MM-DD"), for the office's configured default appointment duration.
 */
export async function getAvailableSlots(
  lawyer: SigningLawyer,
  dateOnly: string,
): Promise<AvailabilityResult> {
  const settings = await getSettings();
  const duration = settings.default_duration_minutes;
  const buffer = settings.buffer_minutes;
  const increment = settings.slot_increment_minutes;

  const parsedDate = parseDateOnly(dateOnly);
  const dow = dayOfWeekInTimeZone(dateOnly, OFFICE_TIMEZONE);
  if (!parsedDate || dow === null) {
    return { lawyer, date: dateOnly, durationMinutes: duration, bufferMinutes: buffer, slotIncrementMinutes: increment, slots: [] };
  }

  const hours = await getLawyerHours(lawyer.id);
  const today = hours.find((h) => h.day_of_week === dow);
  if (!today) {
    return { lawyer, date: dateOnly, durationMinutes: duration, bufferMinutes: buffer, slotIncrementMinutes: increment, slots: [] };
  }

  const start = parseTimeOfDay(today.start_time);
  const end = parseTimeOfDay(today.end_time);
  const windowStart = zonedTimeToUtc(parsedDate.year, parsedDate.month, parsedDate.day, start.hour, start.minute);
  const windowEnd = zonedTimeToUtc(parsedDate.year, parsedDate.month, parsedDate.day, end.hour, end.minute);
  const window: Interval = { start: windowStart.getTime(), end: windowEnd.getTime() };
  if (window.end <= window.start) {
    return { lawyer, date: dateOnly, durationMinutes: duration, bufferMinutes: buffer, slotIncrementMinutes: increment, slots: [] };
  }

  const busy: Interval[] = [];

  // Manual blocks: this lawyer's own rows, plus global (lawyer_id IS NULL) rows.
  const { data: blocks, error: blocksError } = await supabaseAdmin
    .from("signing_blocked_times")
    .select("start_at, end_at, lawyer_id")
    .or(`lawyer_id.eq.${lawyer.id},lawyer_id.is.null`)
    .lt("start_at", windowEnd.toISOString())
    .gt("end_at", windowStart.toISOString());
  if (blocksError) {
    logger.error("[signingAvailability] blocked_times read failed:", blocksError.message);
  } else {
    for (const b of blocks ?? []) {
      busy.push({ start: new Date(b.start_at).getTime(), end: new Date(b.end_at).getTime() });
    }
  }

  // Existing confirmed appointments, each occupying start..end+buffer.
  const { data: appts, error: apptsError } = await supabaseAdmin
    .from("signing_appointments")
    .select("start_at, end_at")
    .eq("lawyer_id", lawyer.id)
    .eq("status", "confirmed")
    .lt("start_at", windowEnd.toISOString())
    .gt("end_at", windowStart.toISOString());
  if (apptsError) {
    logger.error("[signingAvailability] appointments read failed:", apptsError.message);
  } else {
    for (const a of appts ?? []) {
      busy.push({
        start: new Date(a.start_at).getTime(),
        end: new Date(a.end_at).getTime() + buffer * 60_000,
      });
    }
  }

  // The lawyer's real Google Calendar. Best-effort: a freebusy failure (e.g.
  // delegation not yet granted) must not take the whole booking page down —
  // it falls back to our own tables only, which still prevents double-booking
  // through this system even if it can't yet see outside events.
  try {
    const freeBusy = await getFreeBusy(lawyer.email, lawyer.calendar_id, windowStart, windowEnd);
    for (const b of freeBusy) {
      busy.push({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() });
    }
  } catch (err) {
    logger.error("[signingAvailability] Google freebusy failed:", err);
  }

  const free = subtractFromWindow(window, mergeIntervals(busy));

  const slotMs = increment * 60_000;
  const durationMs = duration * 60_000;
  const bufferMs = buffer * 60_000;
  const now = Date.now();

  const slots: string[] = [];
  for (const interval of free) {
    let t = Math.ceil((interval.start - window.start) / slotMs) * slotMs + window.start;
    while (t + durationMs + bufferMs <= interval.end) {
      if (t > now) slots.push(new Date(t).toISOString());
      t += slotMs;
    }
  }

  return { lawyer, date: dateOnly, durationMinutes: duration, bufferMinutes: buffer, slotIncrementMinutes: increment, slots };
}

/** True if `startAtIso` is still a valid, bookable slot right now (race-close re-check). */
export async function isSlotStillAvailable(
  lawyer: SigningLawyer,
  startAtIso: string,
): Promise<boolean> {
  const start = new Date(startAtIso);
  if (isNaN(start.getTime())) return false;
  const dateOnly = new Intl.DateTimeFormat("en-CA", { timeZone: OFFICE_TIMEZONE }).format(start);
  const result = await getAvailableSlots(lawyer, dateOnly);
  return result.slots.includes(start.toISOString());
}
