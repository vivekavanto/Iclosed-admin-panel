// Backdated publish dates for a multi-blog import.
//
// An admin can ask for the blogs of one document to be spread over days, N blogs
// per date. Each upload CONTINUES from where the site's blogs end and never goes
// past today:
//
//   - Take the latest date of any blog on the site (office timezone).
//   - The new blogs start the day after it and move forward one day per group.
//   - The last usable day is TODAY. If there are more blogs than the days between
//     the latest date and today can hold at N per date, the blogs are shared
//     EQUALLY over all of those days instead (10 blogs over 4 days → 3,3,2,2).
//   - If the latest date is already today (or later), everything goes on today.
//   - With no blog on the site yet, the last group takes YESTERDAY and the earlier
//     groups step back from it (6 blogs, 2 per date → 3 days ending yesterday).
//
// Blogs sharing a date get different times so they sort the same way every time —
// the portal reads them oldest-first as a series. Past days run from 09:00 (office
// time); today's blogs are stamped at or just before "now", because the portal
// hides a post whose time is still in the future.

import { OFFICE_TIMEZONE, zonedTimeToUtc } from "./signingTimezone";

export const MAX_BLOGS_PER_DATE = 100;

const FIRST_HOUR = 9;
const MS_PER_DAY = 86_400_000;

/** Minutes between blogs on one past date; shrinks for big groups so they fit in the day. */
function stepMinutes(groupSize: number): number {
  return Math.max(1, Math.min(5, Math.floor(600 / Math.max(1, groupSize))));
}

/** The office-timezone calendar day of an instant, as a whole number of days since the epoch. */
function dayIndexOf(date: Date): number {
  const ymd = date.toLocaleDateString("en-CA", { timeZone: OFFICE_TIMEZONE }); // YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

/** Inverse of dayIndexOf: the [y, m, d] of a day index. */
function ymdOfDayIndex(index: number): [number, number, number] {
  const t = new Date(index * MS_PER_DAY);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/** True for a whole number between 1 and MAX_BLOGS_PER_DATE. */
export function isValidBlogsPerDate(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_BLOGS_PER_DATE;
}

/** How many blogs go on each successive day when filling `size` per day. */
function countsBySize(total: number, size: number): number[] {
  const groups = Math.ceil(total / size);
  return Array.from({ length: groups }, (_, g) => Math.min(size, total - g * size));
}

/** `total` blogs shared as equally as possible over `days` days; earlier days take the extra. */
function countsEvenly(total: number, days: number): number[] {
  const base = Math.floor(total / days);
  const extra = total % days;
  return Array.from({ length: days }, (_, d) => base + (d < extra ? 1 : 0));
}

/**
 * The publish timestamp (UTC ISO) for every article of a document, in document
 * order. `latest` is the latest published_at of any blog already on the site.
 */
export function planBackdatedDates(
  total: number,
  blogsPerDate: number,
  latest: Date | null,
  now: Date = new Date(),
): string[] {
  if (total <= 0) return [];
  const todayIdx = dayIndexOf(now);

  let firstDay: number;
  let counts: number[];
  if (!latest) {
    counts = countsBySize(total, blogsPerDate);
    firstDay = todayIdx - counts.length; // last group lands on yesterday
  } else {
    firstDay = Math.min(dayIndexOf(latest) + 1, todayIdx);
    const days = todayIdx - firstDay + 1;
    counts =
      total <= days * blogsPerDate
        ? countsBySize(total, blogsPerDate)
        : countsEvenly(total, days);
  }

  const [ty, tm, td] = ymdOfDayIndex(todayIdx);
  const startOfToday = zonedTimeToUtc(ty, tm, td, 0, 0);

  const out: string[] = [];
  counts.forEach((n, dayOffset) => {
    const dayIdx = firstDay + dayOffset;
    for (let slot = 0; slot < n; slot++) {
      if (dayIdx === todayIdx) {
        // Oldest first, the last one stamped "now"; never before the day began.
        const at = new Date(now.getTime() - (n - 1 - slot) * 60_000);
        out.push(new Date(Math.max(at.getTime(), startOfToday.getTime())).toISOString());
      } else {
        const [y, m, d] = ymdOfDayIndex(dayIdx);
        const minutes = FIRST_HOUR * 60 + slot * stepMinutes(n);
        out.push(zonedTimeToUtc(y, m, d, Math.floor(minutes / 60), minutes % 60).toISOString());
      }
    }
  });
  return out;
}
