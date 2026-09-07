/**
 * The one place an email leaves this application.
 *
 * ── WHY IDENTITY AND TRANSPORT RESOLVE TOGETHER ─────────────────────────
 * `resolveEmailRoute(firm)` returns the `from`, the `replyTo` AND the provider as
 * a single answer, and that pairing is the whole point rather than a convenience.
 *
 * The From domain and the sending server have to agree or SPF/DKIM alignment
 * fails and the mail is spam-foldered. If `emailFrom()` says
 * `iclosed@navawilson.law` while Resend carries it, delivery depends on
 * navawilson.law being a verified Resend domain — which, as of writing, it is
 * NOT (it publishes no `resend._domainkey` and no SPF at all). Deriving both from
 * one value makes that particular mismatch impossible to construct.
 *
 * ── WHY THIS FACADE DOES NOT THROW ──────────────────────────────────────
 * Providers throw; `sendEmail()` catches and returns `EmailSendResult`.
 *
 * The tempting design is to let the throw escape, so that a caller who ignores
 * the result cannot silently swallow a failure. That is right for THIS repo,
 * where every site that ignores Resend's `{error}` sits inside a try/catch
 * already. It is wrong for the customer portal, where eleven of thirteen sites
 * have no try/catch at all — a throwing facade there would raise unhandled
 * exceptions inside `api/intake` and `api/retainer/sign` and take down intake and
 * retainer signing, which are best-effort by contract.
 *
 * Both repos get the same module, so the safe shape wins. The silent-failure bug
 * is fixed instead by having the providers check `error` (see resendProvider) and
 * by updating the four sites that discard the result — a small, reviewable diff
 * rather than a behaviour that depends on exception propagation.
 */

import { emailFrom, emailReplyTo } from "../emailIdentity.ts";
import type { FirmKey } from "../firms.ts";
import { logger } from "../logger.ts";
import { maskEmail } from "../maskEmail.ts";
import { withRetry } from "../retry.ts";
import { createResendProvider } from "./resendProvider.ts";
import { createSmtpProvider, readSmtpConfig, smtpFrom } from "./smtpProvider.ts";
import {
  EmailSendError,
  type EmailErrorType,
  type EmailMessage,
  type EmailProvider,
  type ProviderName,
} from "./types.ts";

/** What every call site gets back. Never throws; always tells you what happened. */
export type EmailSendResult =
  | { ok: true; id?: string; provider: ProviderName }
  | { ok: false; provider: ProviderName | "none"; error: string; errorType: EmailErrorType };

/**
 * A label identifying which send this is, e.g. "welcome", "auth", "milestone".
 *
 * Two jobs: it appears on every log line so routing is provable after the fact,
 * and it is the key the per-send allowlist matches during rollout. Keep them
 * short, stable and kebab-case — they end up in an environment variable.
 */
export type SendLabel = string;

export interface EmailRoute {
  firm: FirmKey | null;
  from: string;
  replyTo: string;
  provider: EmailProvider;
  providerName: ProviderName;
}

/** Comma-separated env list → trimmed lowercase set. */
function envSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Should this (firm, send) pair go over SMTP?
 *
 * Read at CALL TIME, never cached at module scope. A module-level constant would
 * freeze the value for the life of a warm serverless instance, so flipping the
 * variable would not take effect until that instance was recycled — which is
 * exactly the property you do not want in a kill switch.
 *
 * Both allowlists must match. Empty (the shipped default) means everything stays
 * on Resend, which is today's behaviour byte-for-byte.
 */
function smtpEnabledFor(firm: FirmKey | null, label: SendLabel): boolean {
  if (!firm) return false;
  const firms = envSet(process.env.EMAIL_SMTP_FIRMS);
  if (!firms.has(firm)) return false;
  const sends = envSet(process.env.EMAIL_SMTP_SENDS);
  return sends.has(label.toLowerCase());
}

/**
 * Resolve where a message is sent from and what carries it.
 *
 * `firm == null` is the legacy firm-agnostic path: the address `emailFrom()`
 * returned before firms existed, carried by Resend. That covers the internal
 * staff alerts and the file-less sends (partner codes, the public calculator),
 * which are deliberately not branded per firm.
 */
export function resolveEmailRoute(
  firm: FirmKey | null | undefined,
  label: SendLabel,
): EmailRoute {
  const firmKey = firm ?? null;

  if (firmKey && smtpEnabledFor(firmKey, label)) {
    const suffix = firmKey.toUpperCase();
    const config = readSmtpConfig(suffix);

    // FAIL CLOSED, deliberately breaking with the house fail-open idiom.
    //
    // verifyServiceSignature.ts fails OPEN on missing config, and that is right
    // for an auth check where a not-yet-deployed secret must never block real
    // traffic. Here the opposite holds: falling through to Resend on a config
    // gap is the single most likely way a silent wrong-provider send actually
    // happens — someone sets the allowlist, forgets the password, and mail keeps
    // flowing through Resend while everyone believes the mandate is met.
    if (!config) {
      throw new EmailSendError(
        `SMTP is enabled for firm "${firmKey}" but its configuration is incomplete ` +
          `(need SMTP_HOST_${suffix}, SMTP_USER_${suffix}, SMTP_PASSWORD_${suffix}).`,
        "not_configured",
      );
    }

    return {
      firm: firmKey,
      // The SMTP mailbox may differ from the brand address. Where it does, the
      // server will reject the send — or, on Gmail, SILENTLY REWRITE the From to
      // the authenticated account, which looks like success and defeats the
      // whole mandate. SMTP_FROM_<FIRM> exists so the two can be kept in step.
      from: smtpFrom(suffix) ?? emailFrom(firmKey),
      replyTo: emailReplyTo(firmKey),
      provider: createSmtpProvider(config),
      providerName: "smtp",
    };
  }

  const providerName: ProviderName = "resend";
  const provider = createResendProvider(process.env.RESEND_API_KEY);

  return {
    firm: firmKey,
    from: emailFrom(firmKey),
    replyTo: emailReplyTo(firmKey),
    provider,
    providerName,
  };
}

export interface SendEmailOptions {
  /** The file's firm. Omit (or null) for the legacy firm-agnostic identity. */
  firm?: FirmKey | null;
  /** Which send this is — used for logging and the per-send rollout allowlist. */
  label: SendLabel;
  /** Override the resolved `from`. Only the internal staff alerts need this. */
  from?: string;
  /** Override the resolved `replyTo`; pass `null` to send none at all. */
  replyTo?: string | null;
  /** Retry attempts. Defaults to 3, matching the existing withRetry default. */
  attempts?: number;
}

/** The message as a caller supplies it — identity is resolved for them. */
export type OutgoingEmail = Omit<EmailMessage, "from" | "replyTo">;

/**
 * Send one email.
 *
 * Resolves the firm's identity and transport, retries transient failures, logs a
 * single structured line either way, and returns what happened. Does not throw.
 */
export async function sendEmail(
  message: OutgoingEmail,
  opts: SendEmailOptions,
): Promise<EmailSendResult> {
  // Route resolution can fail closed (SMTP enabled with incomplete config), and
  // this function's contract is that it NEVER throws — a portal call site with
  // no try/catch would otherwise take down intake or retainer signing.
  let route: EmailRoute;
  try {
    route = resolveEmailRoute(opts.firm, opts.label);
  } catch (err) {
    const errorType: EmailErrorType = err instanceof EmailSendError ? err.type : "unknown";
    const errorText = err instanceof Error ? err.message : String(err);
    logger.error(
      `[email] NOT SENT firm=${opts.firm ?? "none"} send=${opts.label} ` +
        `errorType=${errorType}: ${errorText}`,
    );
    // provider "none" is the honest answer: nothing was chosen, so nothing was
    // sent — as opposed to a send that was attempted and refused.
    return { ok: false, provider: "none", error: errorText, errorType };
  }

  const payload: EmailMessage = {
    ...message,
    from: opts.from ?? route.from,
    // `replyTo: null` is meaningfully different from omitting the option: the two
    // internal staff alerts deliberately set no reply-to at all.
    ...(opts.replyTo === null ? {} : { replyTo: opts.replyTo ?? route.replyTo }),
  };

  const started = Date.now();
  const context =
    `firm=${route.firm ?? "none"} provider=${route.providerName} send=${opts.label} ` +
    `to=${payload.to.length}` +
    (payload.cc?.length ? ` cc=${payload.cc.length}` : "") +
    (payload.attachments?.length ? ` attachments=${payload.attachments.length}` : "");

  try {
    const result = await withRetry(() => route.provider.send(payload), {
      // SMTP gets fewer attempts than Resend: a worst-case SMTP attempt is
      // connectionTimeout + greetingTimeout + socketTimeout ≈ 40s, so three of
      // them (~121s) would overrun a sane route budget. Resend keeps the
      // repo's existing default of 3.
      attempts: opts.attempts ?? (route.providerName === "smtp" ? 2 : 3),
      label: `${opts.label}-${route.providerName}`,
      // Never retry a permanent failure — see the note in retry.ts.
      shouldRetry: (err) => !(err instanceof EmailSendError) || err.retryable,
    });

    logger.info(`[email] sent ${context} ms=${Date.now() - started} id=${result.id ?? "-"}`);
    return { ok: true, id: result.id, provider: route.providerName };
  } catch (err) {
    const isKnown = err instanceof EmailSendError;
    const errorType: EmailErrorType = isKnown ? err.type : "unknown";
    const errorText = err instanceof Error ? err.message : String(err);

    // Recipients are masked and the subject is omitted on purpose — both carry
    // client names and property addresses (SEC-022/CMP-008).
    logger.error(
      `[email] FAILED ${context} ms=${Date.now() - started} errorType=${errorType} ` +
        `first=${maskEmail(payload.to[0] ?? "")}: ${errorText}`,
    );
    return { ok: false, provider: route.providerName, error: errorText, errorType };
  }
}
