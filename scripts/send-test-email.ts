/**
 * Send one test email through the real transport, and say which provider carried it.
 *
 * This is the fastest way to answer "is my SMTP configuration actually working"
 * without a lead, a template, a database row, or the idempotency guards that sit
 * in front of every real send. It exercises the SAME resolveEmailRoute() and the
 * SAME provider the app uses, so a pass here means the plumbing is right.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────
 *   node --experimental-strip-types --env-file=.env.local \
 *        scripts/send-test-email.ts you@example.com [firm] [label]
 *
 *   firm   navawilson | iclosed | none     (default: navawilson)
 *   label  welcome, auth, deposit-task, …  (default: welcome)
 *
 * Examples:
 *   # Should go via SMTP once EMAIL_SMTP_FIRMS/SENDS allow it:
 *   … scripts/send-test-email.ts me@gmail.com navawilson welcome
 *
 *   # Must ALWAYS go via Resend — the decisive wrong-provider check:
 *   … scripts/send-test-email.ts me@gmail.com iclosed welcome
 *
 *   # A send that is not on the allowlist — must stay on Resend:
 *   … scripts/send-test-email.ts me@gmail.com navawilson milestone
 *
 * ── IT REALLY SENDS ─────────────────────────────────────────────────────
 * Point it at your own address. Nothing here is sandboxed.
 */

import { resolveEmailRoute, sendEmail } from "../src/lib/email/emailTransport.ts";
import { isFirmKey } from "../src/lib/firms.ts";

// --dry-run resolves the route and prints it WITHOUT sending. Use it to check
// the firm→provider rule across every combination in seconds; it costs nothing
// and mails nobody.
const dryRun = process.argv.includes("--dry-run");
const args = process.argv.slice(2).filter((a) => a !== "--dry-run");
const [toArg, firmArg = "navawilson", label = "welcome"] = args;

if (!toArg) {
  console.error(
    "usage: node --experimental-strip-types --env-file=.env.local " +
      "scripts/send-test-email.ts <to> [navawilson|iclosed|none] [label]",
  );
  process.exit(1);
}

const firm = firmArg === "none" ? null : isFirmKey(firmArg) ? firmArg : null;
if (firmArg !== "none" && !isFirmKey(firmArg)) {
  console.error(`Unknown firm "${firmArg}" — expected navawilson, iclosed or none.`);
  process.exit(1);
}

// Resolve the route FIRST and print it, so you can see which provider was chosen
// even if the send then fails. This is the part worth watching: the send itself
// only proves credentials, the route proves the firm→provider rule.
let route;
try {
  route = resolveEmailRoute(firm, label);
} catch (err) {
  console.error(`\n✖ Route resolution FAILED (this is fail-closed behaviour, not a crash)`);
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(`
  firm      ${firm ?? "none (legacy firm-agnostic)"}
  label     ${label}
  PROVIDER  ${route.providerName.toUpperCase()}
  from      ${route.from}
  reply-to  ${route.replyTo}
  to        ${toArg}

  allowlists: EMAIL_SMTP_FIRMS=${process.env.EMAIL_SMTP_FIRMS ?? "(empty)"} \
EMAIL_SMTP_SENDS=${process.env.EMAIL_SMTP_SENDS ?? "(empty)"}
`);

if (dryRun) {
  console.log("  (--dry-run: nothing was sent)\n");
  process.exit(0);
}

const result = await sendEmail(
  {
    to: [toArg],
    subject: `iClosed transport test — ${route.providerName} / ${firm ?? "no firm"}`,
    html:
      `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">` +
      `<p>This email was carried by <strong>${route.providerName.toUpperCase()}</strong>.</p>` +
      `<ul>` +
      `<li>firm: <code>${firm ?? "none"}</code></li>` +
      `<li>send label: <code>${label}</code></li>` +
      `<li>from: <code>${route.from}</code></li>` +
      `</ul>` +
      `<p style="color:#64748b;font-size:13px">` +
      `Check the raw headers: on Gmail SMTP the <code>Received</code> chain names Google, ` +
      `and the <code>From</code> may be rewritten to the authenticated mailbox.</p></div>`,
    text: `Carried by ${route.providerName}. firm=${firm ?? "none"} label=${label}`,
  },
  { firm, label },
);

if (result.ok) {
  console.log(`✔ SENT via ${result.provider}  id=${result.id ?? "(none returned)"}\n`);
  process.exit(0);
}

console.error(`✖ FAILED via ${result.provider}  errorType=${result.errorType}`);
console.error(`  ${result.error}\n`);

// The most common causes, so the next step is obvious rather than a search.
const hints: Record<string, string> = {
  auth: "Credentials refused. On Gmail this means a normal account password was used instead of a 16-character App Password, or the App Password has been revoked.",
  not_configured:
    "The firm is on EMAIL_SMTP_FIRMS but SMTP_HOST_/SMTP_USER_/SMTP_PASSWORD_ are incomplete. This is fail-closed on purpose — it did NOT fall back to Resend.",
  connection: "Could not reach the server. Outbound 587 may be blocked on this network — try a phone hotspot.",
  timeout: "The server accepted the connection but did not answer in time.",
  rejected:
    "The server understood and refused. For Resend this is usually an unverified sender domain; for SMTP, a From address the mailbox is not allowed to send as.",
};
if (hints[result.errorType]) console.error(`  → ${hints[result.errorType]}\n`);
process.exit(1);
