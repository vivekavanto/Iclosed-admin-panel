/**
 * SMTP, behind the EmailProvider interface.
 *
 * Nava Wilson require their client mail to originate from their own mail server
 * rather than a third-party API. That is a control/compliance requirement, not a
 * deliverability one — Resend could send as navawilson.law once the domain were
 * verified, and it would be simpler. This exists because the firm asked for it.
 *
 * ── ONE-SHOT, NEVER POOLED ──────────────────────────────────────────────
 * `pool: true` is not merely useless here, it is actively harmful. On Vercel's
 * Fluid compute a container persists across invocations, so a module-scope pooled
 * transport genuinely WOULD survive between requests — and then:
 *
 *   • The instance freezes between bursts. The remote server or an intermediate
 *     NAT drops the idle TCP connection, often without a FIN. Nodemailer's pool
 *     does no health check on checkout, so the socket looks alive until you write
 *     to it. The symptom is an intermittent ECONNRESET on the FIRST send after an
 *     idle period — nondeterministic, and unreproducible locally where the
 *     process never freezes.
 *   • Providers cap concurrent authenticated connections per mailbox. Fluid
 *     concurrency times maxConnections trips "421 Too many concurrent
 *     connections".
 *   • An open socket keeps the event loop non-empty, interfering with freeze.
 *
 * Connect, send, close in a `finally`. Every time.
 *
 * ── THE TIMEOUT BUDGET IS NOT DECORATION ────────────────────────────────
 * Worst case per attempt is connectionTimeout + greetingTimeout + socketTimeout
 * ≈ 40s. That is why emailTransport gives SMTP two attempts rather than three
 * (~80s vs ~121s) and why the loop senders are the real timeout risk: N
 * recipients times 40s, not one send.
 */

import {
  EmailSendError,
  type EmailErrorType,
  type EmailMessage,
  type EmailProvider,
  type ProviderSendResult,
} from "./types.ts";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** EHLO identity. Defaults to the deployment host rather than a container id. */
  ehloName?: string;
}

/** The slice of nodemailer this provider uses — the seam tests substitute. */
export interface SmtpTransporter {
  sendMail(message: Record<string, unknown>): Promise<{ messageId?: string }>;
  close(): void;
}

export type MakeTransport = (config: SmtpConfig) => Promise<SmtpTransporter>;

/**
 * Read the SMTP settings for a firm, or null when they are incomplete.
 *
 * Returning null rather than a partial object is what lets the caller fail
 * CLOSED on a half-configured firm instead of quietly falling through to Resend
 * — see the note in emailTransport.resolveEmailRoute.
 */
export function readSmtpConfig(firmEnvSuffix: string): SmtpConfig | null {
  const host = process.env[`SMTP_HOST_${firmEnvSuffix}`]?.trim();
  const user = process.env[`SMTP_USER_${firmEnvSuffix}`]?.trim();
  // App Passwords are displayed in four groups of four. Gmail accepts them
  // either way, but a stray space in an env var is a genuinely nasty bug to
  // chase, so strip whitespace rather than trusting whoever pasted it.
  const pass = process.env[`SMTP_PASSWORD_${firmEnvSuffix}`]?.replace(/\s+/g, "");
  const port = Number(process.env[`SMTP_PORT_${firmEnvSuffix}`] ?? 587);

  if (!host || !user || !pass || !Number.isFinite(port)) return null;

  return {
    host,
    port,
    user,
    pass,
    ehloName: process.env.SMTP_EHLO_NAME?.trim(),
  };
}

/** The `from` override for a firm, when its SMTP mailbox differs from the brand address. */
export function smtpFrom(firmEnvSuffix: string): string | undefined {
  return process.env[`SMTP_FROM_${firmEnvSuffix}`]?.trim() || undefined;
}

/**
 * Map an SMTP failure onto our coarse error types.
 *
 * The reply code is the signal that matters: 5xx is permanent (do not retry),
 * 4xx is transient. Node's socket errors carry a `code` instead.
 */
function classify(err: unknown): EmailErrorType {
  const e = err as { code?: string; responseCode?: number; message?: string };
  const code = (e?.code ?? "").toUpperCase();
  const reply = e?.responseCode;
  const text = (e?.message ?? "").toLowerCase();

  if (code === "EAUTH" || reply === 535 || reply === 534) return "auth";
  if (code === "ETIMEDOUT" || code === "ESOCKET" || text.includes("timeout")) return "timeout";
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "ENOTFOUND") {
    return "connection";
  }
  if (code === "EDNS" || code === "ECONNRESET" || code === "EPIPE") return "connection";
  if (code === "EENVELOPE" || (typeof reply === "number" && reply >= 500)) return "rejected";
  if (typeof reply === "number" && reply >= 400) return "timeout"; // 4xx = try later
  return "unknown";
}

/**
 * Build a real nodemailer transport.
 *
 * The import is dynamic and its specifier is a STRING LITERAL. Both matter:
 * dynamic keeps nodemailer out of every bundle that merely touches email (and
 * out of anything the Edge runtime could reach), while a literal specifier stays
 * statically analysable by Next's file tracer — a computed one would silently
 * ship a function without the module.
 */
const defaultMakeTransport: MakeTransport = async (config) => {
  const nodemailer = await import("nodemailer");

  return nodemailer.default.createTransport({
    host: config.host,
    port: config.port,
    // Implicit TLS from byte 0 on 465; STARTTLS on 587. These MUST agree with
    // the port, so derive rather than configure separately.
    secure: config.port === 465,
    // On 587, abort rather than send in the clear. Without this nodemailer
    // silently falls back to an unencrypted session when the server omits
    // STARTTLS from its EHLO — credentials and client PII in plaintext.
    requireTLS: config.port !== 465,
    auth: { user: config.user, pass: config.pass },

    pool: false,
    maxConnections: 1,

    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    dnsTimeout: 5_000,

    tls: {
      minVersion: "TLSv1.2",
      // NEVER false. A certificate that will not validate means the hostname is
      // wrong; disabling the check makes the connection MITM-able instead.
      rejectUnauthorized: true,
      servername: config.host,
    },

    ...(config.ehloName ? { name: config.ehloName } : {}),

    // Hardening: forbid nodemailer reading local paths or fetching URLs named in
    // message content. Nothing here needs either.
    disableFileAccess: true,
    disableUrlAccess: true,

    // Both would print the SMTP dialogue INCLUDING the AUTH line. Never enable
    // in a deployed environment.
    logger: false,
    debug: false,
  }) as unknown as SmtpTransporter;
};

export function createSmtpProvider(
  config: SmtpConfig,
  makeTransport: MakeTransport = defaultMakeTransport,
): EmailProvider {
  return {
    name: "smtp",

    async send(message: EmailMessage): Promise<ProviderSendResult> {
      let transport: SmtpTransporter | null = null;
      try {
        transport = await makeTransport(config);

        const info = await transport.sendMail({
          from: message.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          ...(message.replyTo ? { replyTo: message.replyTo } : {}),
          ...(message.cc?.length ? { cc: message.cc } : {}),
          ...(message.bcc?.length ? { bcc: message.bcc } : {}),
          ...(message.text ? { text: message.text } : {}),
          ...(message.headers ? { headers: message.headers } : {}),
          // Same { filename, content: Buffer } shape Resend takes, which is why
          // no conversion layer is needed anywhere in either repo.
          ...(message.attachments?.length ? { attachments: message.attachments } : {}),
        });

        return { id: info?.messageId };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        throw new EmailSendError(`SMTP send failed: ${text}`, classify(err));
      } finally {
        // Always, even on failure — a half-open socket left behind is what keeps
        // a serverless instance from freezing.
        try {
          transport?.close();
        } catch {
          // Closing a transport that never connected is not an error worth surfacing.
        }
      }
    },
  };
}
