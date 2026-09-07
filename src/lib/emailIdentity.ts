/**
 * The addresses every outbound email is sent from and replied to.
 *
 * Both were previously inlined at each send site — `from` as
 * `process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>"`, `replyTo`
 * as a hardcoded "testing@iclosed.ca" left over from pre-launch testing. So
 * production mail went out as support@iclosed.ca but every client reply landed
 * in the testing inbox, where nobody reads it.
 *
 * ── NOW FIRM-DEPENDENT ──────────────────────────────────────────────────
 * iClosed serves clients under two entities, and a file's `leads.firm_key`
 * decides which one its mail comes from (see firms.ts / leadFirm.ts):
 *
 *   Nava Wilson  →  iclosed@navawilson.law
 *   iClosed LLP  →  support@iclosed.ca
 *
 * Pass the firm and you get its addresses. Call with NO argument and you get
 * the LEGACY, firm-agnostic behaviour — byte-for-byte what this returned
 * before — so any send site not yet converted keeps sending what it always did.
 *
 * ⚠ OPS PREREQUISITE: navawilson.law must be a VERIFIED sending domain in
 * Resend before Nava Wilson files start sending from it, or every one of those
 * sends fails. Until it is, point that firm at an already-verified address with
 * RESEND_FROM_EMAIL_NAVAWILSON — no code change, no redeploy of this logic.
 *
 * Env overrides, all optional:
 *   RESEND_FROM_EMAIL                 legacy, firm-agnostic  ("iClosed <a@b.ca>")
 *   RESEND_REPLY_TO_EMAIL             legacy, firm-agnostic  ("a@b.ca")
 *   RESEND_FROM_EMAIL_NAVAWILSON      per-firm from
 *   RESEND_FROM_EMAIL_ICLOSED
 *   RESEND_REPLY_TO_EMAIL_NAVAWILSON  per-firm reply-to
 *   RESEND_REPLY_TO_EMAIL_ICLOSED
 *
 * The per-firm vars deliberately do NOT fall back to the legacy ones. The
 * legacy value is a SINGLE address; letting it stand in for a firm would
 * collapse both firms back onto one sender on any deploy that still has it set
 * — which is every current deploy — silently undoing the whole feature.
 */

import { getFirm, type FirmKey } from "./firms.ts";

export const DEFAULT_FROM_EMAIL = "iClosed <support@iclosed.ca>";
export const DEFAULT_REPLY_TO_EMAIL = "support@iclosed.ca";

/**
 * From address for Resend sends.
 *
 * @param firm The file's firm. Omit for the legacy firm-agnostic address.
 */
export function emailFrom(firm?: FirmKey | null): string {
  if (firm == null) return process.env.RESEND_FROM_EMAIL?.trim() || DEFAULT_FROM_EMAIL;
  const profile = getFirm(firm);
  return process.env[profile.fromEnvVar]?.trim() || profile.fromEmail;
}

/**
 * Reply-to address for Resend sends — where client replies actually go.
 *
 * @param firm The file's firm. Omit for the legacy firm-agnostic address.
 */
export function emailReplyTo(firm?: FirmKey | null): string {
  if (firm == null) return process.env.RESEND_REPLY_TO_EMAIL?.trim() || DEFAULT_REPLY_TO_EMAIL;
  const profile = getFirm(firm);
  return process.env[profile.replyToEnvVar]?.trim() || profile.replyToEmail;
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
