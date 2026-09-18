// The standing staff CC on agent-facing mail.
//
// What matters here is the kill switch and the guards, not the address itself:
// AGENT_CC_ALWAYS="" must genuinely mean "copy nobody" (an ops change that must
// not need a deploy), and a bad value must be dropped rather than passed to
// Resend, which rejects the WHOLE send if any one CC is malformed — taking the
// client's email down with it.
//
// Only the pure half of agentCc is exercised. buildAgentCcList() talks to
// Supabase, and CI injects no credentials; supabaseAdmin builds its client at
// import time, so the module needs the two vars present before it is loaded at
// all. Hence the assignments below and the dynamic import.

import assert from "node:assert/strict";
import test from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";

const { standingAgentCcList } = await import("../src/lib/agentCc.ts");

/** Run body with AGENT_CC_ALWAYS set to `value` (undefined = unset). */
function withEnv(value: string | undefined, body: () => void) {
  const had = Object.hasOwn(process.env, "AGENT_CC_ALWAYS");
  const previous = process.env.AGENT_CC_ALWAYS;
  if (value === undefined) delete process.env.AGENT_CC_ALWAYS;
  else process.env.AGENT_CC_ALWAYS = value;
  try {
    body();
  } finally {
    if (had) process.env.AGENT_CC_ALWAYS = previous;
    else delete process.env.AGENT_CC_ALWAYS;
  }
}

test("unset env falls back to the shipped standing CC", () => {
  withEnv(undefined, () => {
    assert.deepEqual(standingAgentCcList(), ["saru@iclosed.ca"]);
  });
});

test("empty env means copy nobody — the no-deploy kill switch", () => {
  withEnv("", () => {
    assert.deepEqual(standingAgentCcList(), []);
  });
  // Whitespace-only is the same intent typed differently.
  withEnv("   ", () => {
    assert.deepEqual(standingAgentCcList(), []);
  });
});

test("env overrides, accepting a comma-separated list", () => {
  withEnv("ops@iclosed.ca, second@iclosed.ca", () => {
    assert.deepEqual(standingAgentCcList(), ["ops@iclosed.ca", "second@iclosed.ca"]);
  });
});

test("a malformed entry is dropped, not handed to the provider", () => {
  withEnv("not-an-email, ops@iclosed.ca", () => {
    assert.deepEqual(standingAgentCcList(), ["ops@iclosed.ca"]);
  });
});

test("the To address is never also CC'd, whatever its case or padding", () => {
  withEnv("ops@iclosed.ca", () => {
    assert.deepEqual(standingAgentCcList(["OPS@iclosed.ca"]), []);
    assert.deepEqual(standingAgentCcList([" ops@iclosed.ca "]), []);
    assert.deepEqual(standingAgentCcList(["agent@brokerage.com"]), ["ops@iclosed.ca"]);
  });
});

test("duplicates within the env list collapse", () => {
  withEnv("ops@iclosed.ca,OPS@iclosed.ca", () => {
    assert.deepEqual(standingAgentCcList(), ["ops@iclosed.ca"]);
  });
});

test("null and undefined exclusions are ignored rather than matching", () => {
  withEnv("ops@iclosed.ca", () => {
    assert.deepEqual(standingAgentCcList([null, undefined, ""]), ["ops@iclosed.ca"]);
  });
});

// Agent-only milestone emails (email_templates.agent_only) address the agent
// instead of the client. The rule that matters is what happens when there is no
// agent: nothing is sent. Falling back to the client would leak an internal
// note ("your client's signing is booked") to the client it is about.
//
// Only the no-partner, no-deal path is exercised here — it is the one branch
// that returns without touching Supabase.
const { buildAgentRecipients } = await import("../src/lib/agentCc.ts");

test("no partner and no deal means no agent recipients, and no standing CC either", async () => {
  const audience = await buildAgentRecipients({ partnerId: null, dealId: null });
  assert.deepEqual(audience.to, []);
  // The oversight copy rides along only when someone is actually being written
  // to; a CC with an empty To is an email to staff about a file nobody asked
  // about.
  assert.deepEqual(audience.cc, []);
  assert.equal(audience.agentName, null);
});
