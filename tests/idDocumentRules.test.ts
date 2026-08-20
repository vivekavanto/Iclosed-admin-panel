// Unit tests for when uploaded IDs may be submitted (src/lib/idDocumentRules.ts).
//
// Two hard rules, both of which had escaped in the field:
//   • Both sides of every ID — a passport's SIGNATURE page, not its rear cover.
//   • Two DIFFERENT types of ID — a driver's licence front and back is one ID,
//     and used to pass an "at least 2 files" check.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyseIdSides,
  completeIdTypes,
  describeMissingSides,
  idSubmissionBlocker,
  secondSideLabel,
  type DetectedIdDoc,
} from "../src/lib/idDocumentRules.ts";

const DL = "Driver's License";
const PASSPORT = "Canadian Passport";

function blockerFor(docs: DetectedIdDoc[]) {
  return idSubmissionBlocker(analyseIdSides(docs));
}

// ───────────────────────────── naming the second side ─────────────────────────────

test("a passport's second side is its signature page, not its back", () => {
  assert.equal(secondSideLabel(PASSPORT), "signature page");
  assert.equal(secondSideLabel("Foreign Passport"), "signature page");
  assert.equal(secondSideLabel(DL), "back");
  assert.equal(secondSideLabel("Permanent Resident Card"), "back");
});

test("describeMissingSides names the page still owed", () => {
  assert.equal(
    describeMissingSides({ type: DL, hasFront: true, hasBack: false }),
    "back",
  );
  assert.equal(
    describeMissingSides({ type: PASSPORT, hasFront: true, hasBack: false }),
    "signature page",
  );
  assert.equal(
    describeMissingSides({ type: DL, hasFront: false, hasBack: true }),
    "front",
  );
  assert.equal(
    describeMissingSides({ type: PASSPORT, hasFront: false, hasBack: false }),
    "front & signature page",
  );
});

// ───────────────────────────── grouping by type ─────────────────────────────

test("every file showing one document collapses into a single type", () => {
  const analysis = analyseIdSides([
    { type: DL, side: "front" },
    { type: DL, side: "back" },
    { type: DL, side: "front" },
  ]);
  assert.equal(analysis.length, 1, "three files of one licence is still one ID");
  assert.equal(analysis[0].complete, true);
});

test("analysis keeps upload order", () => {
  const analysis = analyseIdSides([
    { type: PASSPORT, side: "front" },
    { type: DL, side: "front" },
    { type: PASSPORT, side: "back" },
  ]);
  assert.deepEqual(
    analysis.map((a) => a.type),
    [PASSPORT, DL],
  );
});

// ───────────────────────────── completeness ─────────────────────────────

test("one image holding both sides completes an ID on its own", () => {
  const [passport] = analyseIdSides([{ type: PASSPORT, side: "front-and-back" }]);
  assert.equal(passport.hasBothSides, true);
  assert.equal(passport.complete, true);
});

test("a side that was never established does not count", () => {
  const [dl] = analyseIdSides([
    { type: DL, side: "front" },
    { type: DL, side: "unknown" },
  ]);
  assert.equal(dl.complete, false, "an unknown side is not the missing back");
});

test("completeIdTypes counts distinct documents, not files", () => {
  const analysis = analyseIdSides([
    { type: DL, side: "front" },
    { type: DL, side: "back" },
    { type: PASSPORT, side: "front-and-back" },
  ]);
  assert.equal(completeIdTypes(analysis).length, 2);
});

// ───────────────────────────── what blocks submission ─────────────────────────────

test("a licence uploaded front and back is ONE ID and cannot be submitted alone", () => {
  // The reported bug: two files, both sides present, and the drawer let it go.
  const blocker = blockerFor([
    { type: DL, side: "front" },
    { type: DL, side: "back" },
  ]);
  assert.equal(blocker?.kind, "needs-second-type");
});

test("two different complete IDs may be submitted", () => {
  assert.equal(
    blockerFor([
      { type: DL, side: "front" },
      { type: DL, side: "back" },
      { type: PASSPORT, side: "front" },
      { type: PASSPORT, side: "back" },
    ]),
    null,
  );
});

test("a passport photographed as one open spread satisfies its own sides", () => {
  assert.equal(
    blockerFor([
      { type: DL, side: "front" },
      { type: DL, side: "back" },
      { type: PASSPORT, side: "front-and-back" },
    ]),
    null,
  );
});

test("a missing back blocks submission", () => {
  const blocker = blockerFor([
    { type: DL, side: "front" },
    { type: PASSPORT, side: "front-and-back" },
  ]);
  assert.equal(blocker?.kind, "incomplete-sides");
  assert.deepEqual(
    blocker?.incomplete.map((d) => describeMissingSides(d)),
    ["back"],
  );
});

test("a passport with no signature page blocks submission", () => {
  const blocker = blockerFor([
    { type: DL, side: "front" },
    { type: DL, side: "back" },
    { type: PASSPORT, side: "front" },
  ]);
  assert.equal(blocker?.kind, "incomplete-sides");
  assert.deepEqual(
    blocker?.incomplete.map((d) => describeMissingSides(d)),
    ["signature page"],
  );
});

test("a missing side is reported ahead of a missing second ID", () => {
  // Only one ID, and it's half-provided. Naming the page to photograph is the
  // more actionable of the two complaints.
  const blocker = blockerFor([{ type: PASSPORT, side: "front" }]);
  assert.equal(blocker?.kind, "incomplete-sides");
});

test("nothing uploaded still needs a second ID", () => {
  assert.equal(blockerFor([])?.kind, "needs-second-type");
});

test("every incomplete ID is reported, not just the first", () => {
  const blocker = blockerFor([
    { type: DL, side: "front" },
    { type: PASSPORT, side: "front" },
  ]);
  assert.equal(blocker?.kind, "incomplete-sides");
  assert.deepEqual(
    blocker?.incomplete.map((d) => `${d.type}: ${describeMissingSides(d)}`),
    [`${DL}: back`, `${PASSPORT}: signature page`],
  );
});
