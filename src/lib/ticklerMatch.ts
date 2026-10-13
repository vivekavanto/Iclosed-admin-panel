// Matches pending files to Tickler rows; pure so it can be unit tested.

export type TicklerRow = {
  fileNumber: string;
  opened: Date | null;
  words: Set<string>;
  label: string;
};

export type PendingSide = {
  typeLetter: string;
  street: string;
  lastNames: string[];
  createdAt: string;
};

export type SideMatch =
  | { status: "matched"; fileNumber: string; label: string }
  | { status: "ambiguous"; candidates: { fileNumber: string; label: string }[] }
  | { status: "not_found" };

const ROW_FILE_NUMBER = /^(\d{2})([A-Za-z]{1,3})-?(\d{3,5})$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const OPENED_GRACE_DAYS = 45;

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter(Boolean));
}

// "02-Oct-26", "30-Nov-2026", "6 - Nov - 2026"
export function parseTicklerDate(value: string): Date | null {
  const m = value.trim().match(/^(\d{1,2})\s*-\s*([A-Za-z]{3})[a-z]*\s*-\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(Date.UTC(year, month, Number(m[1])));
}

export function normalizeTicklerFileNumber(value: string): string | null {
  const m = value.trim().match(ROW_FILE_NUMBER);
  return m ? `${m[1]}${m[2].toUpperCase()}-${m[3].padStart(4, "0")}` : null;
}

// Columns: A opened, B file no., C referral, D name, E address (D/E are sometimes swapped).
export function parseTicklerRows(values: string[][]): TicklerRow[] {
  const rows: TicklerRow[] = [];
  for (const r of values) {
    const fileNumber = normalizeTicklerFileNumber(r[1] ?? "");
    if (!fileNumber) continue;
    const name = (r[3] ?? "").trim();
    const address = (r[4] ?? "").trim();
    rows.push({
      fileNumber,
      opened: parseTicklerDate(r[0] ?? ""),
      words: words(`${name} ${address}`),
      label: `${fileNumber} · ${name} · ${address}`,
    });
  }
  return rows;
}

function streetKey(street: string): { number: string; name: string } | null {
  const tokens = [...words(street)];
  const i = tokens.findIndex((t) => /^\d+$/.test(t));
  if (i < 0) return null;
  const name = tokens.slice(i + 1).find((t) => /^[a-z]{3,}$/.test(t));
  return name ? { number: tokens[i], name } : null;
}

export function matchSide(side: PendingSide, rows: TicklerRow[], taken: Set<string>): SideMatch {
  const created = new Date(side.createdAt).getTime() - OPENED_GRACE_DAYS * 86_400_000;
  const pool = rows.filter(
    (r) =>
      r.fileNumber.slice(2, -5) === side.typeLetter &&
      !taken.has(r.fileNumber) &&
      (!r.opened || r.opened.getTime() >= created),
  );
  const key = streetKey(side.street);
  const names = side.lastNames.map((n) => [...words(n)]).flat().filter((n) => n.length >= 2);
  const hasName = (r: TicklerRow) => names.some((n) => r.words.has(n));

  const byAddress = key ? pool.filter((r) => r.words.has(key.number) && r.words.has(key.name)) : [];
  let hits = byAddress;
  if (hits.length > 1) hits = hits.filter(hasName);
  if (hits.length === 1) return { status: "matched", fileNumber: hits[0].fileNumber, label: hits[0].label };

  const suggestions = (byAddress.length ? byAddress : pool.filter(hasName)).slice(0, 5);
  return suggestions.length
    ? { status: "ambiguous", candidates: suggestions.map((r) => ({ fileNumber: r.fileNumber, label: r.label })) }
    : { status: "not_found" };
}
