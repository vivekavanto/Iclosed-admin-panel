import test from "node:test";
import assert from "node:assert/strict";
import { selectHistoricalMailEvidence } from "../../src/lib/orchestrator/audit-evidence.ts";
const cutoff = Date.parse("2026-10-08T18:00:00Z");
const scope = { cutoffExclusiveMs: cutoff, matterNumber: "26P-0612", subjectAliases: ["407-3200 William Coltson Avenue"] };
const mail = (subject: string, from = "Clerk <clerk@example.law>", internalDate = String(cutoff - 1)) => ({ internalDate, payload: { headers: [{ name: "Subject", value: subject }, { name: "From", value: from }] } });
test("full-thread replies after the historical cutoff cannot leak into replay", () => {
  assert.deepEqual(selectHistoricalMailEvidence(mail("26P-0612", undefined, String(cutoff)), scope), { eligible: false, reason: "after-cutoff" });
  assert.equal(selectHistoricalMailEvidence(mail("26P-0612"), scope).eligible, true);
});
test("Slack digests and old audit claims are excluded even with an exact matter hit", () => {
  assert.equal(selectHistoricalMailEvidence(mail("26P-0612", "Slack <notification@slack.com>"), scope).eligible, false);
  assert.equal(selectHistoricalMailEvidence(mail("Signing package QA report 26P-0612"), scope).eligible, false);
  assert.equal(selectHistoricalMailEvidence(mail("Weekly Closing Report 26P-0612"), scope).eligible, false);
});
test("body-only or another-matter search hits require independent scope verification", () => {
  assert.deepEqual(selectHistoricalMailEvidence(mail("Sale 26S-0544"), scope), { eligible: false, reason: "matter-not-established" });
  assert.equal(selectHistoricalMailEvidence(mail("Re: 407-3200 William Coltson Avenue"), scope).eligible, true);
});
test("matter number matching cannot accept longer or embedded unrelated identifiers", () => {
  for (const subject of ["126P-0612", "26P-06120", "A26P0612Z"]) assert.equal(selectHistoricalMailEvidence(mail(subject), scope).eligible, false);
  assert.equal(selectHistoricalMailEvidence(mail("Re: #26P-0612"), scope).eligible, true);
});
test("undated evidence cannot prove historical facts; legitimate lender notices are retained as notices", () => {
  assert.equal(selectHistoricalMailEvidence(mail("26P-0612", undefined, ""), scope).eligible, false);
  assert.equal(selectHistoricalMailEvidence(mail("Request for funds 26P-0612", "Lender <notice@lender.example>"), scope).eligible, true);
  // Eligibility only establishes matter/time scope, never portal acceptance or completion.
});

test('internal test mail cannot establish client notification',()=>{assert.equal(selectHistoricalMailEvidence(mail('[INTERNAL TEST] 26P-0612 Mortgage instructions received'),scope).eligible,false);});

test('verified address threads still exclude derived reports and cutoff violations',()=>{
 assert.equal(selectHistoricalMailEvidence(mail('Re: 12 Janray Dr Closing'),{...scope,addressThreadVerified:true}).eligible,true);
 assert.equal(selectHistoricalMailEvidence(mail('Signing package audit 12 Janray Dr'),{...scope,addressThreadVerified:true}).eligible,false);
 assert.equal(selectHistoricalMailEvidence(mail('12 Janray Dr',undefined,String(cutoff)),{...scope,addressThreadVerified:true}).eligible,false);
});
