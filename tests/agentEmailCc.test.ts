// Pins WHO gets copied on the emails addressed to an agent. A wrong answer here
// is quiet in both directions: a dropped CC means the back office silently stops
// seeing agent notifications, and a malformed one makes Resend reject the whole
// send, so the agent stops getting them too.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  agentEmailCcRecipients,
  DEFAULT_AGENT_EMAIL_CC,
} from "../src/lib/agentEmailCc.ts";

const ORIGINAL = process.env.AGENT_EMAIL_CC;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AGENT_EMAIL_CC;
  else process.env.AGENT_EMAIL_CC = ORIGINAL;
});

test("copies the shipped default when nothing is configured", () => {
  delete process.env.AGENT_EMAIL_CC;
  assert.deepEqual(agentEmailCcRecipients(), [DEFAULT_AGENT_EMAIL_CC]);
  assert.equal(DEFAULT_AGENT_EMAIL_CC, "saru@iclosed.ca");
});

test("the env var overrides, and takes a list", () => {
  process.env.AGENT_EMAIL_CC = "one@iclosed.ca, two@iclosed.ca";
  assert.deepEqual(agentEmailCcRecipients(), ["one@iclosed.ca", "two@iclosed.ca"]);
});

test('"off" drops the CC entirely — how a non-prod environment opts out', () => {
  process.env.AGENT_EMAIL_CC = "off";
  assert.deepEqual(agentEmailCcRecipients(), []);
  process.env.AGENT_EMAIL_CC = "OFF";
  assert.deepEqual(agentEmailCcRecipients(), []);
  process.env.AGENT_EMAIL_CC = "";
  assert.deepEqual(agentEmailCcRecipients(), []);
});

test("the To recipient is never also CC'd", () => {
  process.env.AGENT_EMAIL_CC = "saru@iclosed.ca";
  assert.deepEqual(agentEmailCcRecipients(["SARU@iclosed.ca"]), []);
  assert.deepEqual(agentEmailCcRecipients(["agent@example.com"]), ["saru@iclosed.ca"]);
});

test("a malformed address is dropped and reported, not passed to the provider", () => {
  process.env.AGENT_EMAIL_CC = "not-an-email, good@iclosed.ca";
  const dropped: string[] = [];
  assert.deepEqual(agentEmailCcRecipients([], (a) => dropped.push(a)), ["good@iclosed.ca"]);
  assert.deepEqual(dropped, ["not-an-email"]);
});

test("duplicates collapse case-insensitively", () => {
  process.env.AGENT_EMAIL_CC = "saru@iclosed.ca, Saru@iclosed.ca";
  assert.deepEqual(agentEmailCcRecipients(), ["saru@iclosed.ca"]);
});
