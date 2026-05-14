const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T\s]/;

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  month: "short",
  day: "numeric",
  year: "numeric",
};

// Parse a date string into a local Date. Rules:
//   1. "YYYY-MM-DD"           → parsed as local midnight (no UTC shift).
//   2. "YYYY-MM-DDTHH..." or
//      "YYYY-MM-DD HH..."     → date portion parsed as local midnight; the
//                               time-of-day is intentionally dropped so the
//                               displayed date never rolls a day forward or
//                               backward because of timezone math.
//   3. Anything else          → `new Date(...)` fallback. Returns null only
//                               if the value is truly unparseable.
export function parseLocalDate(dateString: string | null | undefined): Date | null {
  if (!dateString) return null;
  return parseLocal(String(dateString).trim());
}

function buildLocal(y: number, m: number, d: number): Date | null {
  if (!Number.isFinite(y)) return null;
  const date = new Date(y, m - 1, d);
  if (isNaN(date.getTime())) return null;
  return date;
}

function parseLocal(s: string): Date | null {
  if (!s) return null;

  if (DATE_ONLY_RE.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return buildLocal(y, m, d);
  }

  const tsMatch = TIMESTAMP_RE.exec(s);
  if (tsMatch) {
    const [y, m, d] = tsMatch[1].split("-").map(Number);
    return buildLocal(y, m, d);
  }

  const parsed = new Date(s);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

export function formatLocalDate(
  dateString: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = DEFAULT_OPTS,
  locale: string = "en-US",
): string {
  const d = parseLocalDate(dateString);
  if (!d) return "";
  return d.toLocaleDateString(locale, opts);
}

export function formatLocalDateTime(
  dateString: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  locale: string = "en-US",
): string {
  const d = parseLocalDate(dateString);
  if (!d) return "";
  return d.toLocaleString(locale, opts);
}
