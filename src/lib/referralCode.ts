/**
 * How a partner's `referral_code` is built.
 *
 * The scheme is FIRST NAME + the initial of the SECOND name + the year:
 *
 *     Sarujan Kana        → SARUJANK2026
 *     Aliya Ali Shaikha   → ALIYAA2026      (the SECOND token, "Ali", not "Shaikha")
 *     Raninder Dhillon    → RANINDERD2026
 *
 * It replaces a first-name prefix plus a globally sequential number
 * (`SARUJAN0001`, migrations/2026-07-10-partner-referral-codes.sql). The number
 * was unique but said nothing about whose code it was; a partner reading it back
 * over the phone could not tell their own code from anyone else's.
 *
 * ── COLLISIONS ──────────────────────────────────────────────────────────
 * Two partners can share a first name and an initial. The second one takes ONE
 * MORE letter of the second name, and keeps taking letters until the code is
 * free — FIRST COME, FIRST SERVED, which is why generation needs the set of
 * codes already in use and is not a pure function of the name:
 *
 *     Raninder Khal   (first)  → RANINDERK2026
 *     Raninder Khali  (second) → RANINDERKH2026   ...K taken, so extend
 *
 * Note this means the same name can produce different codes depending on what
 * already exists, and that a code is NEVER recomputed for an existing partner —
 * `referral_code` is written once at creation and is stable thereafter.
 *
 * ── MIRROR IN THE PORTAL ────────────────────────────────────────────────
 * `iclosed_dev_web/src/lib/referralCode.ts` is the same module, because intake
 * find-or-creates a partner for a keyed-in agent (`resolvePartner.ts`) against
 * the SAME table. Both must build codes identically or the two apps disagree
 * about what a partner's code should be. Deliberately dependency-free so it can
 * be copied verbatim between repos and unit-tested without a database.
 */

/**
 * The year every code ends with.
 *
 * A CONSTANT, not `new Date().getFullYear()`. Rolling over automatically would
 * silently start issuing 2027 codes at midnight on Jan 1 while every code in the
 * database and every code an agent has been given says 2026 — a cohort split
 * nobody decided on. Changing the cohort is a business decision; when it is
 * made, move this in BOTH repos.
 */
export const REFERRAL_CODE_YEAR = "2026";

/** Longest first-name run kept, so a pathological name cannot produce a 60-char code. */
const MAX_FIRST_LENGTH = 20;

/** Longest second-name run a collision can extend into. */
const MAX_SECOND_LENGTH = 12;

/** Uppercase A–Z only — drops accents, apostrophes, hyphens and digits. */
function letters(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z]/g, "");
}

export interface ReferralCodeParts {
  /** The first name, uppercased letters only. Never empty. */
  first: string;
  /** The second name, uppercased letters only. Empty for a single-token name. */
  second: string;
}

/**
 * Split a partner's name into the two runs a code is built from.
 *
 * Falls back to the email local-part when there is no usable name, then to
 * "PTNR" — the same two fallbacks the sequential scheme used, because
 * `agent_name` is nullable and intake can create a partner from an email alone.
 */
export function referralCodeParts(
  name?: string | null,
  email?: string | null,
): ReferralCodeParts {
  const tokens = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const first =
    letters(tokens[0]) || letters((email ?? "").split("@")[0]) || "PTNR";
  return {
    first: first.slice(0, MAX_FIRST_LENGTH),
    second: letters(tokens[1]).slice(0, MAX_SECOND_LENGTH),
  };
}

/**
 * Every code this name could take, shortest first.
 *
 * The caller walks it and takes the first one free. Ends with numbered variants
 * for the case where two partners share an identical first AND second name —
 * rare, but the alternative is failing to create the partner at all. The digit
 * goes BEFORE the year so every code still ends in the cohort year.
 */
function* candidates({ first, second }: ReferralCodeParts): Generator<string> {
  if (second === "") {
    yield `${first}${REFERRAL_CODE_YEAR}`;
  } else {
    for (let take = 1; take <= second.length; take++) {
      yield `${first}${second.slice(0, take)}${REFERRAL_CODE_YEAR}`;
    }
  }
  for (let n = 2; n <= 99; n++) {
    yield `${first}${second}${n}${REFERRAL_CODE_YEAR}`;
  }
}

/**
 * The code a new partner should get.
 *
 * `taken` is every code already in use — pass ALL of them, including
 * soft-deleted partners', so a retired partner's code is never reissued to
 * someone else. Compared case-insensitively.
 *
 * Throws only if all ~100 numbered variants are also taken, which cannot happen
 * short of deliberate abuse; callers already surface a 409 for it.
 */
export function buildReferralCode(opts: {
  name?: string | null;
  email?: string | null;
  taken: Iterable<string | null | undefined>;
}): string {
  const used = new Set<string>();
  for (const code of opts.taken) {
    const trimmed = (code ?? "").trim().toUpperCase();
    if (trimmed) used.add(trimmed);
  }

  const parts = referralCodeParts(opts.name, opts.email);
  for (const candidate of candidates(parts)) {
    if (!used.has(candidate)) return candidate;
  }

  throw new Error(
    `Could not build a unique referral code for ${JSON.stringify(opts.name ?? opts.email ?? "")}.`,
  );
}
