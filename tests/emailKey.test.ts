// Regression tests for the address matching that the agent signup notification
// depends on. The bug these exist for: intake stored "someone@example.com "
// verbatim while Supabase Auth registered the trimmed address, so every exact
// lookup missed the row, the deal stayed "Inactive", and sendAgentSignupEmail's
// activation gate held the agent's email back forever — reporting success at
// every step.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeEmailKey, sameEmail } from "../src/lib/emailKey.ts";

test("normalizeEmailKey strips the whitespace a paste leaves behind", () => {
  assert.equal(normalizeEmailKey(" someone@example.com "), "someone@example.com");
  assert.equal(normalizeEmailKey("someone@example.com "), "someone@example.com");
  assert.equal(normalizeEmailKey("​someone@example.com"), "someone@example.com");
  assert.equal(normalizeEmailKey("﻿someone@example.com "), "someone@example.com");
  assert.equal(normalizeEmailKey("Someone@Example.com"), "someone@example.com");
  assert.equal(normalizeEmailKey(null), "");
  assert.equal(normalizeEmailKey(undefined), "");
});

test("sameEmail matches a stored address against the trimmed auth identity", () => {
  // The exact shape of the production rows that went missing.
  assert.equal(sameEmail("marycris4539@yahoo.ca ", "marycris4539@yahoo.ca"), true);
  assert.equal(sameEmail("chuthan@live.com ", "CHUTHAN@live.com"), true);
  assert.equal(sameEmail("a@b.ca", " a@b.ca"), true);
});

test("sameEmail does not match different people", () => {
  assert.equal(sameEmail("foo@bar.com", "foo@bar.com.au"), false);
  assert.equal(sameEmail("foo@bar.com", "foo+1@bar.com"), false);
  assert.equal(sameEmail("a_b@x.com", "aXb@x.com"), false);
});

test("an empty address never matches anything", () => {
  // Guards the wildcard lookup: an empty key would otherwise build "%%" and
  // match every row in the table.
  assert.equal(sameEmail("", ""), false);
  assert.equal(sameEmail("   ", "someone@example.com"), false);
  assert.equal(sameEmail(null, null), false);
});
