import assert from "node:assert/strict";
import test from "node:test";
import {
  matchSide,
  normalizeTicklerFileNumber,
  parseTicklerDate,
  parseTicklerRows,
} from "../src/lib/ticklerMatch.ts";

const rows = parseTicklerRows([
  ["File Opening date", "File No.", "Referrals", "NAME", "ADDRESS"],
  ["02-Oct-26", "26P-0644", "Repeating client", "Jonathan JEYARAJAH", "1473 Sandhurst Crescent, Pickering, ON"],
  ["02-Oct-26", "26S-0649", "Agent", "MARIA BEDONIA & RICKY BEDONIA", "55-1055 Central Park Boulevard N, Oshawa, ON"],
  ["09-Oct-26", "26P-0659", "Agent", "Hannah BEDONIA, Ricky BEDONIA", "69 Kintyre Street, Courtice, ON"],
  ["08-Oct-26", "26R-0657", "Antrim", "130 Eagleridge Dr, Brampton, ON", "Rupinder Ghanaut"],
  ["06-Oct-26", "26p-0037", "", "Lower Case", "12 Main Street, Toronto"],
  ["", "USE FOR NEXT SALE FILE", "", "", ""],
]);

const side = (typeLetter: string, street: string, lastNames: string[] = []) => ({
  typeLetter,
  street,
  lastNames,
  createdAt: "2026-10-05T00:00:00Z",
});

test("parses dates and normalizes file numbers", () => {
  assert.equal(parseTicklerDate("02-Oct-26")?.toISOString().slice(0, 10), "2026-10-02");
  assert.equal(parseTicklerDate("6 - Nov - 2026")?.toISOString().slice(0, 10), "2026-11-06");
  assert.equal(parseTicklerDate("TBD"), null);
  assert.equal(normalizeTicklerFileNumber("26p-0037"), "26P-0037");
  assert.equal(normalizeTicklerFileNumber("USE FOR NEXT SALE FILE"), null);
  assert.equal(rows.length, 5);
});

test("matches on type letter and street", () => {
  assert.deepEqual(matchSide(side("P", "1473 Sandhurst Cres"), rows, new Set()), {
    status: "matched",
    fileNumber: "26P-0644",
    label: "26P-0644 · Jonathan JEYARAJAH · 1473 Sandhurst Crescent, Pickering, ON",
  });
  assert.equal(matchSide(side("S", "1473 Sandhurst Cres"), rows, new Set()).status, "not_found");
});

test("matches when name and address columns are swapped", () => {
  const m = matchSide(side("R", "130 Eagleridge Drive"), rows, new Set());
  assert.equal(m.status === "matched" && m.fileNumber, "26R-0657");
});

test("skips numbers already used by another file", () => {
  assert.equal(matchSide(side("P", "1473 Sandhurst Cres"), rows, new Set(["26P-0644"])).status, "not_found");
});

test("suggests rows that only match the client name", () => {
  const m = matchSide(side("P", "1 Unknown Road", ["Bedonia"]), rows, new Set());
  assert.equal(m.status, "ambiguous");
  assert.deepEqual(m.status === "ambiguous" && m.candidates.map((c) => c.fileNumber), ["26P-0659"]);
});

test("ignores rows opened long before the file was created", () => {
  const old = { ...side("P", "1473 Sandhurst Cres"), createdAt: "2027-03-01T00:00:00Z" };
  assert.equal(matchSide(old, rows, new Set()).status, "not_found");
});
