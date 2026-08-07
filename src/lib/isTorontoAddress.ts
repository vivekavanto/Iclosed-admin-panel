// Is this property in the City of Toronto?
//
// It decides whether the Toronto municipal land transfer tax and the Toronto
// first-time-buyer rebate apply — roughly $18,000 either way on a $1M purchase —
// so getting it wrong is not a cosmetic error.
//
// ── What was here before ────────────────────────────────────────────────
// `/\btoronto\b/i.test(address)`, which failed both ways:
//
//   "2 Progress Ave, Scarborough"      → missed. Scarborough, North York,
//   "45 Yonge St, North York"            Etobicoke, East York and York have all
//   "300 The East Mall, Etobicoke"       been the City of Toronto since the 1998
//                                        amalgamation. MLTT applies.
//   "5 Toronto Street, Mississauga"    → charged. A street named Toronto is not
//                                        a property in Toronto.
//
// ── How it decides ──────────────────────────────────────────────────────
// 1. POSTAL CODE, when there is one. Every Toronto forward sortation area
//    begins with M, and no other municipality in Canada uses M. That makes it
//    the strongest signal available, and it is trusted OVER the municipality
//    name: "Toronto St, Mississauga, ON L5A 1B2" is settled by the L.
//
// 2. Otherwise the MUNICIPALITY name — but only from address parts that carry
//    no digits. A street line ("5 Toronto Street") always has a number; a
//    municipality line ("Scarborough") does not. That one rule is what stops a
//    street name being mistaken for a city.
//
// PURE by design: no Supabase, no React, no Date. Twin file — an identical copy
// lives in the customer portal repo at src/lib/isTorontoAddress.ts, because the
// admin app prefills the flag from it and the portal locks the client's
// estimate to it. The two must never disagree about the same address.

/** Former municipalities amalgamated into the City of Toronto in 1998. */
export const TORONTO_MUNICIPALITIES = [
  "toronto",
  "scarborough",
  "north york",
  "etobicoke",
  "east york",
  "york",
] as const;

/** A Canadian postal code, whole or partial, anywhere in the string. */
const POSTAL_RE = /\b([A-Za-z])\d[A-Za-z]\s?\d[A-Za-z]\d\b/;

/** The Toronto forward sortation area letter. Unique to Toronto in Canada. */
const TORONTO_POSTAL_LETTER = "M";

/** Lowercase, strip punctuation and digits, collapse whitespace. */
function normalise(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when this address part NAMES one of the Toronto municipalities.
 *
 * Whole-word matching, so "Yorkville" and "Yorkdale" do not count as "York".
 */
function namesTorontoMunicipality(part: string): boolean {
  const s = normalise(part);
  if (!s) return false;
  return TORONTO_MUNICIPALITIES.some(
    (m) =>
      s === m ||
      s.startsWith(`${m} `) ||
      s.endsWith(` ${m}`) ||
      s.includes(` ${m} `),
  );
}

/**
 * Whether a property address is in the City of Toronto.
 *
 * Returns false for an empty or unparseable address: charging a municipal tax
 * nobody has confirmed is worse than omitting one a clerk can still tick on.
 */
export function isTorontoAddress(address: unknown): boolean {
  const raw = String(address ?? "").trim();
  if (!raw) return false;

  // 1. Postal code decides on its own, in BOTH directions.
  const postal = raw.match(POSTAL_RE);
  if (postal) {
    return postal[1].toUpperCase() === TORONTO_POSTAL_LETTER;
  }

  // 2. No postal code — fall back to the municipality name, ignoring any part
  //    that carries a digit, because that part is a street or a unit.
  return raw
    .split(",")
    .filter((part) => !/\d/.test(part))
    .some(namesTorontoMunicipality);
}
