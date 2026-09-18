// Pure address-comparison helpers, kept free of any Supabase import so they can
// be unit-tested (and used from anywhere) without a configured client. The
// queries that use them live in emailLookup.ts.

/**
 * The comparable form of an address: zero-width characters removed, non-breaking
 * spaces folded to ordinary ones, trimmed, lower-cased.
 *
 * Case folding is for COMPARISON ONLY — never write this back to a row. The
 * local part of an address is case-sensitive per RFC 5321 even though no mail
 * provider in practice treats it that way, so narrowing a stored value would be
 * a change nobody asked for; matching loosely is not.
 */
export function normalizeEmailKey(email: string | null | undefined): string {
  return (email ?? "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .trim()
    .toLowerCase();
}

/** True when two addresses are the same once whitespace and case are ignored. */
export function sameEmail(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const left = normalizeEmailKey(a);
  return left !== "" && left === normalizeEmailKey(b);
}
