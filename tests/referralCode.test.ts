// Partner referral-code generation: FIRSTNAME + second name's initial + 2026.
//
// The cases below are the ones the scheme was specified with, kept verbatim
// because they pin down the two things a plain reading of "first name + initial"
// gets wrong: the initial comes from the SECOND token (so "Aliya Ali Shaikha" is
// ALIYAA, not ALIYAS), and a collision is resolved FIRST COME, FIRST SERVED by
// lengthening the newcomer's code, never by renaming whoever holds it.
//
// This module is mirrored verbatim in the portal. If a case here changes, the
// copy at iclosed_dev_web/src/lib/referralCode.ts changes with it, or intake and
// the admin panel will mint different codes for the same partner.

import assert from "node:assert/strict";
import test from "node:test";

import {
  REFERRAL_CODE_YEAR,
  buildReferralCode,
  referralCodeParts,
} from "../src/lib/referralCode.ts";

/** Build against a fixed set of already-issued codes. */
function code(name: string, taken: string[] = [], email?: string) {
  return buildReferralCode({ name, email, taken });
}

test("the specified examples", () => {
  assert.equal(code("Sarujan Kana"), "SARUJANK2026");
  assert.equal(code("Aliya Ali Shaikha"), "ALIYAA2026");
  assert.equal(code("Raninder Dhillon"), "RANINDERD2026");
});

test("the initial comes from the second token, not the last", () => {
  // "Ali" is the second token; "Shaikha" is the last. The spec says ALIYAA2026.
  assert.equal(referralCodeParts("Aliya Ali Shaikha").second, "ALI");
});

test("a collision takes one more letter of the second name", () => {
  // Khal is issued first and keeps K; Khali arrives later and extends to KH.
  const first = code("Raninder Khal", ["RANINDERD2026"]);
  assert.equal(first, "RANINDERK2026");

  const second = code("Raninder Khali", ["RANINDERD2026", first]);
  assert.equal(second, "RANINDERKH2026");

  // A third, longer name extends again rather than reusing either.
  assert.equal(
    code("Raninder Khalifa", ["RANINDERD2026", first, second]),
    "RANINDERKHA2026",
  );
});

test("first come, first served — an existing holder is never recomputed", () => {
  // Same two people, registered in the opposite order: now Khali holds the K.
  const khali = code("Raninder Khali", []);
  assert.equal(khali, "RANINDERK2026");
  assert.equal(code("Raninder Khal", [khali]), "RANINDERKH2026");
});

test("codes are unique across a whole cohort, whatever the order", () => {
  const names = [
    "Sarujan Kana",
    "Sarujan Kanagasabai",
    "Sarujan Karim",
    "Sarujan",
    "Raninder Khal",
    "Raninder Khali",
    "Aliya Ali Shaikha",
    "Aliya Ali",
  ];
  const issued: string[] = [];
  for (const name of names) issued.push(code(name, issued));

  assert.equal(new Set(issued).size, names.length, `not unique: ${issued.join(", ")}`);
  for (const c of issued) assert.ok(c.endsWith(REFERRAL_CODE_YEAR), `${c} lacks the year`);
});

test("a single-token name gets no initial", () => {
  assert.equal(code("Cher"), "CHER2026");
});

test("identical full names fall back to a number, still ending in the year", () => {
  const first = code("Raninder Khal");
  // Every letter of "Khal" is exhausted by four previous holders.
  const taken = ["RANINDERK2026", "RANINDERKH2026", "RANINDERKHA2026", "RANINDERKHAL2026"];
  const next = code("Raninder Khal", taken);
  assert.equal(first, "RANINDERK2026");
  assert.equal(next, "RANINDERKHAL22026");
  assert.ok(next.endsWith(REFERRAL_CODE_YEAR));
});

test("punctuation, accents and case are normalised away", () => {
  // Note an accent is DROPPED, not folded: "josé" contributes JOS, not JOSE.
  assert.equal(code("josé  o'brien"), "JOSO2026");
  assert.equal(code("Mary-Jane Smith-Jones"), "MARYJANES2026");
});

test("a blank name falls back to the email local-part, then to PTNR", () => {
  assert.equal(buildReferralCode({ name: "", email: "dana@brokerage.com", taken: [] }), "DANA2026");
  assert.equal(buildReferralCode({ name: null, email: null, taken: [] }), "PTNR2026");
});

test("the taken list is matched case- and whitespace-insensitively", () => {
  assert.equal(code("Sarujan Kana", [" sarujank2026 "]), "SARUJANKA2026");
});
