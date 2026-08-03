/**
 * Shared outbound-email addressing.
 *
 * Every `resend.emails.send()` call in this app must use `EMAIL_REPLY_TO` for
 * its `replyTo` — client replies land in the monitored support inbox, not in a
 * test mailbox. Import this constant instead of hardcoding an address.
 */
export const EMAIL_REPLY_TO =
  process.env.RESEND_REPLY_TO_EMAIL || "support@iclosed.ca";
