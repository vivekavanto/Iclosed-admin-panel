// "Book at least N business days before closing" rule for signing appointments.
// N is signing_settings.min_business_days_before_closing (admin-configurable).
//
// A business day is Monday-Friday that is not a holiday. Holidays are whatever
// the office already blocks for everyone in signing_blocked_times (lawyer_id
// NULL) across the working day, so the booking calendar and this count agree.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { OFFICE_TIMEZONE, parseDateOnly, zonedTimeToUtc } from "./signingTimezone";

/** Pull a YYYY-MM-DD out of what the portal sends (date or ISO timestamp). */
export function normalizeClosingDate(raw: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((raw ?? "").trim());
  if (!m || !parseDateOnly(m[1])) return null;
  return m[1];
}

function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

/**
 * Dates in [fromIso, toIso] on which the whole office is closed: a global
 * block covers 09:00-17:00 office time.
 */
async function loadClosedDates(fromIso: string, toIso: string): Promise<Set<string>> {
  const closed = new Set<string>();
  const f = parseDateOnly(fromIso);
  const t = parseDateOnly(toIso);
  if (!f || !t) return closed;

  const { data, error } = await supabaseAdmin
    .from("signing_blocked_times")
    .select("start_at, end_at")
    .is("lawyer_id", null)
    .lt("start_at", zonedTimeToUtc(t.year, t.month, t.day, 23, 59).toISOString())
    .gt("end_at", zonedTimeToUtc(f.year, f.month, f.day, 0, 0).toISOString());
  if (error) {
    logger.error("[signingCutoff] blocked_times read failed:", error.message);
    return closed;
  }

  for (let day = fromIso; day <= toIso; day = addDays(day, 1)) {
    const p = parseDateOnly(day);
    if (!p) continue;
    const open = zonedTimeToUtc(p.year, p.month, p.day, 9, 0, OFFICE_TIMEZONE).getTime();
    const close = zonedTimeToUtc(p.year, p.month, p.day, 17, 0, OFFICE_TIMEZONE).getTime();
    if ((data ?? []).some((b) => new Date(b.start_at).getTime() <= open && new Date(b.end_at).getTime() >= close)) {
      closed.add(day);
    }
  }
  return closed;
}

/**
 * The last office-local date a signing may be booked on: `closingDate` stepped
 * back `businessDays` business days (weekends and office-wide closures skipped).
 * Returns null (no restriction) when there is no usable closing date or the
 * rule is off (businessDays <= 0).
 */
export async function latestSigningDate(
  closingDate: string | null | undefined,
  businessDays: number,
): Promise<string | null> {
  const iso = normalizeClosingDate(closingDate);
  if (!iso || !Number.isFinite(businessDays) || businessDays <= 0) return null;

  const steps = Math.floor(businessDays);
  // Generous look-back: N business days never spans more than ~N*2+10 calendar days.
  const closed = await loadClosedDates(addDays(iso, -(steps * 2 + 14)), iso);

  let cursor = iso;
  let remaining = steps;
  while (remaining > 0) {
    cursor = addDays(cursor, -1);
    const [y, m, d] = cursor.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6 && !closed.has(cursor)) remaining -= 1;
  }
  return cursor;
}
