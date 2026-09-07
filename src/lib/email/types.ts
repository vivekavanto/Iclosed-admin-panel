/**
 * The shape every outbound email takes, independent of who carries it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────
 * Until now there was no such thing as "an email" in this codebase — there were
 * thirteen hand-rolled `resend.emails.send({...})` calls, each constructing its
 * own client and each handling failure differently. That was survivable while
 * Resend was the only transport. It stops being survivable the moment a file's
 * firm decides WHICH SERVER sends its mail, because "which provider" then has
 * thirteen places to be decided and thirteen places to get wrong.
 *
 * So: one message type, one provider interface, one place that picks.
 *
 * ── THE FIELD LIST IS DELIBERATELY SMALL ────────────────────────────────
 * Only what the repo actually sends today (from, to, cc, replyTo, subject,
 * html, attachments), plus `bcc`/`text`/`headers`, which cost nothing to carry
 * now and are painful to retrofit through two repos later. Nothing else from
 * Resend's API is modelled: `tags`, `scheduledAt` and `react` have zero call
 * sites, and a field no provider implements is a lie in the type.
 */

/**
 * A file attached to an email.
 *
 * `content` is a raw Buffer — NOT base64. Both providers encode internally
 * (Resend's SDK does it on the wire; nodemailer does it when building the MIME
 * part), so encoding here would double-encode. This is already the shape every
 * attachment-bearing send in the repo builds, which is why the SMTP path needs
 * no conversion layer at all.
 */
export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

/** One email, fully resolved and ready to hand to a provider. */
export interface EmailMessage {
  /** Display-name + address, e.g. `iClosed <support@iclosed.ca>`. */
  from: string;
  /** Where a reply actually lands. Omitted only by the internal staff alerts. */
  replyTo?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html: string;
  /**
   * Plain-text alternative.
   *
   * Unused today — every email in both repos is HTML-only. Carried because
   * nodemailer, unlike Resend, will NOT synthesise one, and an HTML-only message
   * scores worse with content filters. Populate it when convenient; nothing
   * depends on it yet.
   */
  text?: string;
  /** Extra MIME headers. Unused today; here for List-Unsubscribe and the like. */
  headers?: Record<string, string>;
  attachments?: EmailAttachment[];
}

/** Which transport carried (or would have carried) a message. */
export type ProviderName = "resend" | "smtp";

/**
 * How a send failed, coarsely.
 *
 * Coarse ON PURPOSE. This is what gets logged and what retry logic branches on,
 * and both of those become unreadable if they have to string-match a provider's
 * prose. The distinction that actually matters operationally is "will trying
 * again ever help": `auth`, `rejected` and `not_configured` are permanent,
 * `connection` and `timeout` are worth a retry.
 */
export type EmailErrorType =
  | "auth"           // credentials refused — retrying will never help
  | "connection"     // could not reach the server — transient
  | "timeout"        // reached it, no timely answer — transient
  | "rejected"       // server understood and refused (bad recipient, unverified domain)
  | "not_configured" // this firm is meant to use SMTP but its config is incomplete
  | "unknown";

/** What a provider hands back on success. */
export interface ProviderSendResult {
  /** The provider's own message id, when it gives one. Never persisted today. */
  id?: string;
}

/**
 * A transport.
 *
 * Implementations THROW on failure — see `EmailSendError`. That is an internal
 * convention, not the shape call sites see: `sendEmail()` catches and returns a
 * result. The reason is in emailTransport.ts, and it is load-bearing.
 */
export interface EmailProvider {
  readonly name: ProviderName;
  send(message: EmailMessage): Promise<ProviderSendResult>;
}

/**
 * A failure with its type already classified.
 *
 * Providers throw this rather than a bare Error so the facade can log and retry
 * on `type` without re-parsing a message it did not write.
 */
export class EmailSendError extends Error {
  readonly type: EmailErrorType;
  /** True when trying again could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, type: EmailErrorType = "unknown") {
    super(message);
    this.name = "EmailSendError";
    this.type = type;
    this.retryable = type === "connection" || type === "timeout";
  }
}
