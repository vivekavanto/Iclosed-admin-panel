/**
 * Resend, behind the EmailProvider interface.
 *
 * This is a WRAPPER, not a rewrite. The call it makes is byte-for-byte the one
 * the thirteen send sites were making individually, because the whole promise of
 * this change is that iClosed mail behaves exactly as it did before. The only
 * thing that moves is WHERE the call lives.
 *
 * ── THE ONE REAL BEHAVIOUR CHANGE ───────────────────────────────────────
 * The Resend SDK RETURNS `{ data, error }`; it does not throw when the API
 * rejects a send. Four call sites in this repo awaited it and discarded the
 * result, so a refused send — most often a 403 for an unverified sender domain —
 * reported as a success: the toast said sent, the row was stamped "emailed", and
 * nothing left Resend. sendFinalReportEmail.ts:324-343 documents the same bug
 * being found and fixed once already.
 *
 * Checking `error` here fixes that class of bug for every site at once, and
 * cannot regress: there is no longer a result for a caller to ignore.
 */

import { Resend } from "resend";
import {
  EmailSendError,
  type EmailErrorType,
  type EmailMessage,
  type EmailProvider,
  type ProviderSendResult,
} from "./types.ts";

/**
 * Map a Resend rejection onto our coarse error types.
 *
 * Resend's `error.name` is a stable machine-readable slug, so prefer it and fall
 * back to sniffing the message only when it is absent. The distinction that
 * matters is permanent-vs-transient — see EmailErrorType.
 */
function classify(name: string | undefined, message: string): EmailErrorType {
  const slug = (name ?? "").toLowerCase();
  const text = message.toLowerCase();

  if (slug.includes("missing_api_key") || slug.includes("restricted_api_key")) return "auth";
  if (slug.includes("invalid_api_key") || text.includes("api key")) return "auth";
  // "The <domain> domain is not verified" — the single commonest rejection here,
  // and the one that will bite navawilson.law until it is verified in Resend.
  if (slug.includes("not_found") || slug.includes("validation_error")) return "rejected";
  if (slug.includes("invalid_from") || text.includes("not verified")) return "rejected";
  if (slug.includes("rate_limit") || text.includes("too many")) return "timeout";
  if (text.includes("timeout") || text.includes("etimedout")) return "timeout";
  if (text.includes("econnrefused") || text.includes("enotfound") || text.includes("fetch failed")) {
    return "connection";
  }
  return "unknown";
}

export function createResendProvider(apiKey: string | undefined): EmailProvider {
  return {
    name: "resend",

    async send(message: EmailMessage): Promise<ProviderSendResult> {
      // Guarded here rather than at module scope so that importing this file can
      // never take out a route. Nine of the thirteen call sites used to make this
      // check themselves; four did not and would construct a client with an
      // undefined key.
      if (!apiKey) {
        throw new EmailSendError(
          "Email service not configured (missing RESEND_API_KEY)",
          "not_configured",
        );
      }

      const resend = new Resend(apiKey);

      let data: { id?: string } | null;
      let error: { name?: string; message?: string } | null;
      try {
        ({ data, error } = await resend.emails.send({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          // Spread the optionals rather than passing undefined: the SDK treats a
          // present-but-undefined `cc` differently from an absent one on some
          // versions, and an empty array is not the same as "no CC".
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.bcc?.length ? { bcc: message.bcc } : {}),
          ...(message.text ? { text: message.text } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        }));
      } catch (err) {
        // A genuine transport-level throw (DNS, socket, aborted fetch) rather
        // than an API-level rejection.
        const text = err instanceof Error ? err.message : String(err);
        throw new EmailSendError(`Resend request failed: ${text}`, classify(undefined, text));
      }

      if (error) {
        const text = error.message || "Resend rejected the send";
        throw new EmailSendError(text, classify(error.name, text));
      }

      return { id: data?.id };
    },
  };
}
