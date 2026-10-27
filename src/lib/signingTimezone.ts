// Timezone helpers for the signing-appointment booking system.
//
// signing_lawyer_hours.start_time/end_time are office-local wall-clock times
// (both lawyers work out of the Scarborough office), not UTC. Everything
// stored elsewhere (signing_appointments.start_at, Google Calendar events) is
// a real UTC instant. These helpers convert between the two, including DST,
// without pulling in a timezone library the repo doesn't otherwise depend on.

export const OFFICE_TIMEZONE = "America/Toronto";

/**
 * The UTC instant corresponding to a wall-clock date+time in `timeZone`.
 *
 * Format the UTC guess through the target timezone as numeric parts, measure how
 * far that zone is from UTC at that instant, and correct for it. Reads the parts
 * directly (never re-parses a formatted string), so the result does not depend on
 * the timezone of the machine running this: a dev box in India and Vercel (UTC)
 * agree. Not meant for the exact DST-transition hour.
 */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asIfUtc - utcMs;
}

export function zonedTimeToUtc(
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  timeZone: string = OFFICE_TIMEZONE,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(utcGuess - zoneOffsetMs(utcGuess, timeZone));
}

/** Parse "HH:MM" or "HH:MM:SS" into { hour, minute }. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/** Parse "YYYY-MM-DD" into { year, month, day }. */
export function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 0 (Sun) .. 6 (Sat) for a "YYYY-MM-DD" calendar date, as seen in `timeZone`. */
export function dayOfWeekInTimeZone(dateOnly: string, timeZone: string = OFFICE_TIMEZONE): number | null {
  const parsed = parseDateOnly(dateOnly);
  if (!parsed) return null;
  // Noon avoids any DST-boundary ambiguity about which calendar day this is.
  const noon = zonedTimeToUtc(parsed.year, parsed.month, parsed.day, 12, 0, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(noon);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? null;
}

/** "YYYY-MM-DD" for "today" as seen in `timeZone`. */
export function todayInTimeZone(timeZone: string = OFFICE_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}
