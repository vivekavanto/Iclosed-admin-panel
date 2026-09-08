// Provider selection and message mapping for the email transport.
//
// The guarantee under test is narrow and load-bearing: an email must NEVER leave
// through a provider its firm did not choose. Everything else here (message
// mapping, retry classification) exists to protect that one property, because a
// message that reaches the wrong server cannot be un-sent.
//
// These run with no network, no credentials and no mocking library — CI injects
// no secrets, so a test that needed a real SMTP server could never run there.
// The seam is dependency injection: providers are plain objects behind an
// interface, so a recording fake substitutes for one.

import assert from "node:assert/strict";
import test from "node:test";

import { withRetry } from "../src/lib/retry.ts";
import { EmailSendError } from "../src/lib/email/types.ts";
import type { EmailErrorType, EmailMessage, EmailProvider } from "../src/lib/email/types.ts";
import {
  createSmtpProvider,
  readSmtpConfig,
  smtpAllowsSelfSigned,
} from "../src/lib/email/smtpProvider.ts";
import type { MakeTransport } from "../src/lib/email/smtpProvider.ts";

// ── Fakes ──────────────────────────────────────────────────────────────

/** Records what it was asked to send; never touches the network. */
function recordingProvider(name: "resend" | "smtp") {
  const sent: EmailMessage[] = [];
  const provider: EmailProvider = {
    name,
    async send(message) {
      sent.push(message);
      return { id: `${name}-1` };
    },
  };
  return { provider, sent };
}

/** Fails a given number of times, then succeeds. */
function flakyProvider(failures: number, err: unknown) {
  let calls = 0;
  const provider: EmailProvider = {
    name: "smtp",
    async send() {
      calls += 1;
      if (calls <= failures) throw err;
      return { id: "ok" };
    },
  };
  return { provider, calls: () => calls };
}

// ── The allowlist rule ─────────────────────────────────────────────────
//
// Mirrors smtpEnabledFor() in emailTransport.ts. Tested as a pure function
// against an injected config rather than through process.env: node:test runs
// files concurrently, so mutating the environment leaks between tests.

function smtpEnabledFor(
  firm: string | null,
  label: string,
  cfg: { firms?: string; sends?: string },
): boolean {
  const set = (raw: string | undefined) =>
    new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  const wild = (v: Set<string>) => v.has("all") || v.has("*");
  if (!firm) return false;
  const firms = set(cfg.firms);
  if (!firms.has(firm) && !wild(firms)) return false;
  const sends = set(cfg.sends);
  return wild(sends) || sends.has(label.toLowerCase());
}

// N — the property that matters most: never the wrong provider.
test("iClosed files never route to SMTP, whatever the allowlists say", () => {
  const configs = [
    {},
    { firms: "navawilson", sends: "welcome" },
    { firms: "navawilson,iclosed", sends: "welcome" }, // even when listed…
  ];
  // …the last one DOES enable it — that is the point of an explicit allowlist.
  assert.equal(smtpEnabledFor("iclosed", "welcome", configs[0]), false);
  assert.equal(smtpEnabledFor("iclosed", "welcome", configs[1]), false);
  assert.equal(smtpEnabledFor("iclosed", "welcome", configs[2]), true);
});

// K / L — an unresolvable or unknown firm must fall back to Resend, never SMTP.
test("a missing or unknown firm never routes to SMTP", () => {
  const cfg = { firms: "navawilson,iclosed", sends: "welcome" };
  assert.equal(smtpEnabledFor(null, "welcome", cfg), false);
  assert.equal(smtpEnabledFor("", "welcome", cfg), false);
  assert.equal(smtpEnabledFor("acme-legal", "welcome", cfg), false);
});

// The shipped default: both allowlists empty means nothing changes at all.
test("empty allowlists keep every firm on Resend", () => {
  assert.equal(smtpEnabledFor("navawilson", "welcome", {}), false);
  assert.equal(smtpEnabledFor("navawilson", "welcome", { firms: "navawilson" }), false);
  assert.equal(smtpEnabledFor("navawilson", "welcome", { sends: "welcome" }), false);
});

// B — both allowlists must agree, which is what lets one send be enabled at a time.
test("SMTP requires BOTH the firm and the send to be allowlisted", () => {
  const cfg = { firms: "navawilson", sends: "deposit-task,closing-estimate" };
  assert.equal(smtpEnabledFor("navawilson", "deposit-task", cfg), true);
  assert.equal(smtpEnabledFor("navawilson", "closing-estimate", cfg), true);
  assert.equal(smtpEnabledFor("navawilson", "welcome", cfg), false);
});

// The "I want every email on SMTP" case — a hand-kept label list is friction
// once a firm is known-good, and a send added later would silently stay on
// Resend until someone remembered to list it.
test("EMAIL_SMTP_SENDS=all covers every send for an allowlisted firm", () => {
  const cfg = { firms: "navawilson", sends: "all" };
  for (const label of ["welcome", "final-report", "auth", "milestone", "anything-new"]) {
    assert.equal(smtpEnabledFor("navawilson", label, cfg), true, label);
  }
  assert.equal(smtpEnabledFor("navawilson", "welcome", { firms: "navawilson", sends: "*" }), true);
});

// The wildcard must WIDEN an allowlisted firm, never add a new one.
test("EMAIL_SMTP_SENDS=all does not pull in a firm that is not allowlisted", () => {
  const cfg = { firms: "navawilson", sends: "all" };
  assert.equal(smtpEnabledFor("iclosed", "welcome", cfg), false);
  assert.equal(smtpEnabledFor("iclosed", "final-report", cfg), false);
});

// Firm-agnostic sends pass firm: null in code, so no env value can reach them.
test("no wildcard can route a firm-agnostic send over SMTP", () => {
  for (const cfg of [
    { firms: "all", sends: "all" },
    { firms: "*", sends: "*" },
  ]) {
    assert.equal(smtpEnabledFor(null, "clerk-documents", cfg), false);
    assert.equal(smtpEnabledFor(null, "all-tasks-complete", cfg), false);
    assert.equal(smtpEnabledFor(null, "partner-code", cfg), false);
  }
});

test("allowlist parsing tolerates spacing and casing", () => {
  const cfg = { firms: " NavaWilson , iclosed ", sends: " Welcome ,, auth " };
  assert.equal(smtpEnabledFor("navawilson", "welcome", cfg), true);
  assert.equal(smtpEnabledFor("navawilson", "WELCOME", cfg), true);
  assert.equal(smtpEnabledFor("navawilson", "milestone", cfg), false);
});

// ── Message mapping ────────────────────────────────────────────────────

test("a provider receives the message unchanged, attachments included", async () => {
  const { provider, sent } = recordingProvider("smtp");
  const attachment = { filename: "statement.pdf", content: Buffer.from("%PDF-1.4") };

  await provider.send({
    from: "iClosed <iclosed@navawilson.law>",
    replyTo: "iclosed@navawilson.law",
    to: ["a@example.com", "b@example.com"],
    cc: ["agent@example.com"],
    subject: "Your closing",
    html: "<p>Hi</p>",
    attachments: [attachment],
  });

  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.deepEqual(msg.to, ["a@example.com", "b@example.com"]);
  assert.deepEqual(msg.cc, ["agent@example.com"]);
  assert.equal(msg.replyTo, "iclosed@navawilson.law");
  // The Buffer must survive intact — both providers encode it themselves, so a
  // stray toString("base64") here would double-encode and corrupt the file.
  assert.ok(Buffer.isBuffer(msg.attachments?.[0].content));
  assert.equal(msg.attachments?.[0].content.toString(), "%PDF-1.4");
  assert.equal(msg.attachments?.[0].filename, "statement.pdf");
});

// ── Retry classification ───────────────────────────────────────────────

test("a permanent failure is attempted exactly once", async () => {
  const authFailure = new EmailSendError("535 bad credentials", "auth");
  const { provider, calls } = flakyProvider(99, authFailure);

  await assert.rejects(
    withRetry(() => provider.send(msg()), {
      attempts: 3,
      baseMs: 1,
      shouldRetry: (err) => !(err instanceof EmailSendError) || err.retryable,
    }),
    /535 bad credentials/,
  );
  // Retrying bad credentials never succeeds and invites rate-limiting.
  assert.equal(calls(), 1);
});

test("a transient failure is retried and can succeed", async () => {
  const blip = new EmailSendError("ECONNRESET", "connection");
  const { provider, calls } = flakyProvider(1, blip);

  const result = await withRetry(() => provider.send(msg()), {
    attempts: 3,
    baseMs: 1,
    shouldRetry: (err) => !(err instanceof EmailSendError) || err.retryable,
  });

  assert.equal(result.id, "ok");
  assert.equal(calls(), 2);
});

test("an unclassified error is still retried", async () => {
  const { provider, calls } = flakyProvider(1, new Error("who knows"));
  await withRetry(() => provider.send(msg()), { attempts: 2, baseMs: 1 });
  assert.equal(calls(), 2);
});

test("EmailSendError marks only connection and timeout as retryable", () => {
  assert.equal(new EmailSendError("x", "connection").retryable, true);
  assert.equal(new EmailSendError("x", "timeout").retryable, true);
  assert.equal(new EmailSendError("x", "auth").retryable, false);
  assert.equal(new EmailSendError("x", "rejected").retryable, false);
  assert.equal(new EmailSendError("x", "not_configured").retryable, false);
  assert.equal(new EmailSendError("x", "unknown").retryable, false);
});

function msg(): EmailMessage {
  return {
    from: "iClosed <support@iclosed.ca>",
    to: ["client@example.com"],
    subject: "Test",
    html: "<p>Test</p>",
  };
}

// ── The SMTP provider ──────────────────────────────────────────────────
//
// Driven through an injected transport factory, so these need no SMTP server,
// no credentials and no mocking library — CI injects no secrets, so a test that
// needed a real server could never run there.

/** Records what nodemailer would have been asked to send. */
function fakeTransport() {
  const sent: Record<string, unknown>[] = [];
  let closed = 0;
  const make: MakeTransport = async () => ({
    async sendMail(m) {
      sent.push(m);
      return { messageId: "<abc@smtp>" };
    },
    close() {
      closed += 1;
    },
  });
  return { make, sent, closed: () => closed };
}

test("SMTP maps every field nodemailer needs, attachments as Buffers", async () => {
  const { make, sent } = fakeTransport();
  const provider = createSmtpProvider(
    { host: "smtp.gmail.com", port: 587, user: "u@example.com", pass: "x" },
    make,
  );

  const result = await provider.send({
    from: "iClosed <iclosed@navawilson.law>",
    replyTo: "iclosed@navawilson.law",
    to: ["a@example.com", "b@example.com"],
    cc: ["agent@example.com"],
    bcc: ["file@example.com"],
    subject: "Deposit",
    html: "<p>Hi</p>",
    text: "Hi",
    attachments: [{ filename: "s.pdf", content: Buffer.from("%PDF") }],
  });

  assert.equal(result.id, "<abc@smtp>");
  const m = sent[0];
  assert.deepEqual(m.to, ["a@example.com", "b@example.com"]);
  assert.deepEqual(m.cc, ["agent@example.com"]);
  assert.deepEqual(m.bcc, ["file@example.com"]);
  assert.equal(m.replyTo, "iclosed@navawilson.law");
  assert.equal(m.text, "Hi");
  const attachments = m.attachments as Array<{ filename: string; content: Buffer }>;
  assert.ok(Buffer.isBuffer(attachments[0].content));
  assert.equal(attachments[0].content.toString(), "%PDF");
});

test("the transport is closed even when the send fails", async () => {
  let closed = 0;
  const make: MakeTransport = async () => ({
    async sendMail() {
      throw Object.assign(new Error("nope"), { code: "ECONNREFUSED" });
    },
    close() {
      closed += 1;
    },
  });
  const provider = createSmtpProvider(
    { host: "h", port: 587, user: "u", pass: "p" },
    make,
  );

  await assert.rejects(provider.send(msg()));
  // A socket left open is what stops a serverless instance freezing.
  assert.equal(closed, 1);
});

test("SMTP failures are classified so retry can tell permanent from transient", async () => {
  const cases: Array<[Record<string, unknown>, EmailErrorType, boolean]> = [
    [{ code: "EAUTH" }, "auth", false],
    [{ responseCode: 535 }, "auth", false],
    [{ code: "ECONNREFUSED" }, "connection", true],
    [{ code: "ETIMEDOUT" }, "timeout", true],
    [{ code: "EENVELOPE" }, "rejected", false],
    [{ responseCode: 550 }, "rejected", false],
    [{ responseCode: 451 }, "timeout", true], // 4xx = try later
    // A chain that will not verify is a local trust-store problem, not a blip:
    // permanent, so the send is attempted once instead of twice.
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "not_configured", false],
    [{ code: "ESOCKET", cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }, "not_configured", false],
  ];

  for (const [shape, expectedType, expectedRetryable] of cases) {
    const make: MakeTransport = async () => ({
      async sendMail() {
        throw Object.assign(new Error("boom"), shape);
      },
      close() {},
    });
    const provider = createSmtpProvider({ host: "h", port: 587, user: "u", pass: "p" }, make);

    await provider.send(msg()).then(
      () => assert.fail("should have thrown"),
      (err: unknown) => {
        assert.ok(err instanceof EmailSendError);
        assert.equal(err.type, expectedType, `for ${JSON.stringify(shape)}`);
        assert.equal(err.retryable, expectedRetryable, `for ${JSON.stringify(shape)}`);
      },
    );
  }
});

// ── Config reading ─────────────────────────────────────────────────────

test("an incomplete SMTP config reads as null, so the caller can fail closed", () => {
  const prev = { ...process.env };
  try {
    delete process.env.SMTP_HOST_TESTFIRM;
    delete process.env.SMTP_USER_TESTFIRM;
    delete process.env.SMTP_PASSWORD_TESTFIRM;
    assert.equal(readSmtpConfig("TESTFIRM"), null);

    process.env.SMTP_HOST_TESTFIRM = "smtp.gmail.com";
    // Host alone is not enough — this is the half-configured case that must
    // never quietly fall through to Resend.
    assert.equal(readSmtpConfig("TESTFIRM"), null);

    process.env.SMTP_USER_TESTFIRM = "u@example.com";
    process.env.SMTP_PASSWORD_TESTFIRM = "abcd efgh ijkl mnop";
    const cfg = readSmtpConfig("TESTFIRM");
    assert.ok(cfg);
    // Gmail shows App Passwords in four groups of four; a pasted space would
    // otherwise travel into the AUTH string.
    assert.equal(cfg.pass, "abcdefghijklmnop");
    assert.equal(cfg.port, 587, "defaults to 587 when unset");
  } finally {
    process.env = prev;
  }
});

// ── TLS trust ──────────────────────────────────────────────────────────
// A developer machine that re-signs TLS (antivirus, proxy, VPN) cannot verify
// smtp.gmail.com's chain, and every send fails with "self-signed certificate in
// certificate chain". The escape hatch for that must not be reachable from a
// deployment — an unverified certificate in production is a MITM nobody sees.

test("nodemailer's own ESOCKET wording is still recognised as a trust failure", async () => {
  const make: MakeTransport = async () => ({
    async sendMail() {
      throw Object.assign(new Error("self-signed certificate in certificate chain"), {
        code: "ESOCKET",
      });
    },
    close() {},
  });
  const provider = createSmtpProvider({ host: "h", port: 587, user: "u", pass: "p" }, make);

  await provider.send(msg()).then(
    () => assert.fail("should have thrown"),
    (err: unknown) => {
      assert.ok(err instanceof EmailSendError);
      // ESOCKET alone would have read as a timeout and been retried.
      assert.equal(err.type, "not_configured");
      assert.equal(err.retryable, false);
      // The message has to say what to do — the admin UI shows it verbatim.
      assert.match(err.message, /NODE_EXTRA_CA_CERTS/);
      assert.match(err.message, /SMTP_TLS_ALLOW_SELF_SIGNED/);
    },
  );
});

test("certificate verification can only be relaxed off a deployment", () => {
  const saved = {
    flag: process.env.SMTP_TLS_ALLOW_SELF_SIGNED,
    vercel: process.env.VERCEL,
    nodeEnv: process.env.NODE_ENV,
  };
  const set = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  try {
    delete process.env.VERCEL;
    set("NODE_ENV", "development");

    // Off by default, and only an explicit opt-in turns it on.
    delete process.env.SMTP_TLS_ALLOW_SELF_SIGNED;
    assert.equal(smtpAllowsSelfSigned(), false);
    for (const value of ["", "0", "no", "false"]) {
      process.env.SMTP_TLS_ALLOW_SELF_SIGNED = value;
      assert.equal(smtpAllowsSelfSigned(), false, `for ${JSON.stringify(value)}`);
    }
    for (const value of ["1", "true", "TRUE"]) {
      process.env.SMTP_TLS_ALLOW_SELF_SIGNED = value;
      assert.equal(smtpAllowsSelfSigned(), true, `for ${JSON.stringify(value)}`);
    }

    // Neither Vercel nor a production build honours it, whatever it says.
    process.env.SMTP_TLS_ALLOW_SELF_SIGNED = "1";
    process.env.VERCEL = "1";
    assert.equal(smtpAllowsSelfSigned(), false);
    delete process.env.VERCEL;
    set("NODE_ENV", "production");
    assert.equal(smtpAllowsSelfSigned(), false);
  } finally {
    set("SMTP_TLS_ALLOW_SELF_SIGNED", saved.flag);
    set("VERCEL", saved.vercel);
    set("NODE_ENV", saved.nodeEnv);
  }
});
