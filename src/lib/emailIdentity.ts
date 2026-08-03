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
