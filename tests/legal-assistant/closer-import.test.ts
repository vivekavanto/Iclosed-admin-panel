import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCloserReport, reconcile, closerIdentity, dateValue } from "../../src/lib/orchestrator/closer-import.ts";
import { inDashboard } from "../../src/lib/orchestrator/model.ts";

const filename = "Closer_Report_Closing_2026-10-01_to_2026-12-31_run_2026-10-20.csv";
const header = "file.number,file.type,file.status,file.url,dates.closing,property.address,file.clerk,file.lawyer,clients.names";
const row = "26P-0901,purchase,active,https://app.closer.ca/app/matter/one,2026-10-21,18 Maple Grove,Marcela Pitella,Kubes,Alex Morgan";
const batch = (r = row, name = filename) => parseCloserReport(name, header + "\r\n" + r);
test("quoted fields preserve commas, newlines, escaped quotes and BOM", () => {
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"a,b","say ""hi""\nthere"\r\n'), [["a", "b"], ["a,b", 'say "hi"\nthere']]);
});
test("rejects truncated, malformed, empty and duplicate-column reports", () => {
  assert.throws(() => parseCsv('a,b\n"unfinished'), /incomplete/);
  assert.throws(() => parseCsv('a,b\n"a"oops,b'), /Unexpected/);
  assert.throws(() => parseCloserReport(filename, header), /Empty/);
  assert.throws(() => parseCloserReport(filename, header + ",file.number\n" + row + ",26P-0901"), /Duplicate CSV/);
});
test("rejects invalid date, duplicate file and unsafe external URL", () => {
  assert.throws(() => batch(row.replace("2026-10-21", "2026-02-30")), /Invalid date/);
  assert.throws(() => batch(row + "\n" + row), /Duplicate file/);
  assert.throws(() => batch(row.replace("https://app.closer.ca", "https://evil.example")), /invalid Closer/);
  assert.equal(closerIdentity("https://app.closer.ca.evil.example/app/matter/one"), null);
  assert.equal(closerIdentity("javascript:alert(1)"), null);
});
test("validates exact calendar dates and long-format summary dates", () => {
  assert.equal(dateValue("December 31, 2026"), "2026-12-31");
  assert.throws(() => dateValue("November 31, 2026"));
});
test("reimport creates no duplicate and counts unchanged", () => {
  const b = batch(); const a = reconcile([], b); const next = reconcile(a.matters, b);
  assert.equal(a.created, 1); assert.equal(next.created, 0); assert.equal(next.unchanged, 1); assert.equal(next.matters.length, 1);
});
test("date and clerk changes update same identity while preserving folder and firm", () => {
  const b = batch(); b.matters[0].driveFolderId = "verified-folder"; b.matters[0].firm = "iclosed";
  const changed = batch(row.replace("2026-10-21", "2026-12-28").replace("Marcela Pitella", "Suganya Argeen"));
  const r = reconcile(b.matters, changed);
  assert.equal(r.updated, 1); assert.equal(r.matters[0].id, b.matters[0].id);
  assert.equal(r.matters[0].driveFolderId, "verified-folder"); assert.equal(r.matters[0].firm, "iclosed");
  assert.equal(r.matters[0].closingDate, "2026-12-28"); assert.equal(r.matters[0].clerk, "Suganya Argeen");
});
test("missing files retained without inferring closure", () => {
  const r = reconcile(batch().matters, batch(row.replace("0901", "0902").replace("/one", "/two")));
  assert.equal(r.matters.length, 2); assert.equal(r.matters[0].status, "active"); assert.equal(r.matters[0].sourcePresent, false);
});
test("partial November report does not mark December files missing", () => {
  const prior = batch(row.replace("2026-10-21", "2026-12-21")).matters;
  const b = batch(row.replace("0901", "0902").replace("/one", "/two"), filename.replace("to_2026-12-31", "to_2026-11-30"));
  assert.equal(reconcile(prior, b).matters[0].sourcePresent, true);
});
test("older extracts cannot overwrite current details", () => {
  const b = batch();
  assert.throws(() => reconcile(b.matters, batch(row, filename.replace("run_2026-10-20", "run_2026-10-19"))), /newer extract/);
});
test("date window is inclusive and explicit status controls visibility", () => {
  const m = batch().matters[0];
  assert.equal(inDashboard(m), true); assert.equal(inDashboard({ ...m, closingDate: "2026-12-31" }), true);
  assert.equal(inDashboard({ ...m, closingDate: "2027-01-01" }), false);
  assert.equal(inDashboard({ ...m, status: "closed" }), false);
});
test("same file number cannot silently map to a different Closer identity", () => {
  assert.throws(() => reconcile(batch().matters, batch(row.replace("/one", "/different"))), /different Closer/);
});
test("summary reports stay explicit about missing fields", () => {
  const b = parseCloserReport("Closer_Active_Files_Closing_by_2027-01-16_run_2026-10-18.csv", "File Number,File Type,Status,Closing date,Address,Clerk,Lawyer\n26P-0901,purchase,Active,\"October 21, 2026\",18 Maple Grove,Marcela,Kubes");
  assert.equal(b.kind, "summary"); assert.equal(b.matters[0].closerUrl, null); assert.equal(b.warnings.length, 1);
});

test("Closer refresh preserves the verified signing report link", () => {
 const prior=batch().matters[0]; prior.auditReport={documentId:"verified-doc",url:"https://docs.google.com/document/d/verified-doc/edit",verifiedAt:"2026-10-20T18:00:00Z"};
 const next=reconcile([prior],batch(row.replace("2026-10-21","2026-10-22")));
 assert.deepEqual(next.matters[0].auditReport,prior.auditReport);
});
