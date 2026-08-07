/**
 * The addresses every outbound email is sent from and replied to.
 *
 * Both were previously inlined at each send site — `from` as
 * `process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>"`, `replyTo`
 * as a hardcoded "testing@iclosed.ca" left over from pre-launch testing. So
 * production mail went out as support@iclosed.ca but every client reply landed
 * in the testing inbox, where nobody reads it.
 *
 * Reply-to now defaults to support@iclosed.ca, and both are env-overridable so
 * a non-production deploy can point its mail somewhere else without touching
 * code:
 *   RESEND_FROM_EMAIL      e.g. "iClosed <support@iclosed.ca>"  (display name + address)
 *   RESEND_REPLY_TO_EMAIL  e.g. "support@iclosed.ca"            (bare address)
 */

export const DEFAULT_FROM_EMAIL = "iClosed <support@iclosed.ca>";
export const DEFAULT_REPLY_TO_EMAIL = "support@iclosed.ca";

/** From address for Resend sends. */
export function emailFrom(): string {
  return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
}

/** Reply-to address for Resend sends — where client replies actually go. */
export function emailReplyTo(): string {
  return process.env.RESEND_REPLY_TO_EMAIL?.trim() || DEFAULT_REPLY_TO_EMAIL;
}

/**
 * Clean a recipient address read out of the database before handing it to
 * Supabase Auth or Resend.
 *
 * Intake stores whatever the client typed, and a copy-pasted address routinely
 * carries invisible padding — a trailing space, a non-breaking space, a
 * zero-width character. These render identically on screen and survive the
 * admin edit form's validation (JS `\s` does not match U+200B/U+FEFF), but
 * GoTrue rejects such an address outright with "Unable to validate email
 * address: invalid format" and the send dies before Resend is ever called.
 * From the admin's side that is indistinguishable from a broken template or a
 * bad API key, so normalise at every send boundary rather than trusting the
 * column to be clean.
 *
 * Deliberately conservative: strip zero-width characters, fold non-breaking
 * spaces into ordinary ones, then trim the ends. Interior characters are left
 * alone — an address with a space in the middle is genuinely invalid and
 * should still fail loudly instead of being silently "repaired".
 */
export function normalizeRecipientEmail(email: string | null | undefined): string {
  return (email ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00A0/g, " ")
    .trim();
}
