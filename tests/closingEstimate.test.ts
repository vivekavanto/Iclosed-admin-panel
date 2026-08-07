// Per-file estimate rules that are NOT arithmetic.
//
// `finalStatementBlocker` is the one the requirements call out by name: "Admin
// Final mode: require an entered property-tax/adjustment figure rather than
// defaulting to the placeholder, so a final statement never ships with a
// placeholder." A draft is seeded with the firm's planning figure ($1,000 out
// of the box); a Statement of Account that quietly carried it would be stating
// a number nobody chose as though it were settled.

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEstimateRow,
  finalStatementBlocker,
  parseEstimatePayload,
} from "../src/lib/closingEstimate.ts";
import { defaultStatementType } from "../src/lib/closingCostSettings.ts";

// ── the final-account rule ────────────────────────────────────────────

test("finalStatementBlocker: a draft never needs the adjustment", () => {
  assert.equal(finalStatementBlocker("draft", null), null);
  assert.equal(finalStatementBlocker("draft", undefined), null);
  assert.equal(finalStatementBlocker(null, null), null);
});

test("finalStatementBlocker: a final without a figure is blocked", () => {
  for (const missing of [null, undefined, "", "not a number", NaN]) {
    const blocker = finalStatementBlocker("final", missing);
    assert.ok(blocker, `${String(missing)} should be blocked`);
    assert.match(blocker, /property tax/i);
  }
});

test("finalStatementBlocker: an entered figure passes", () => {
  assert.equal(finalStatementBlocker("final", 1234.56), null);
  assert.equal(finalStatementBlocker("final", "1234.56"), null);
});

test("finalStatementBlocker: zero is an answer, not an omission", () => {
  // Nothing owing either way is a real outcome, and it is the one a naive
  // truthiness check would reject.
  assert.equal(finalStatementBlocker("final", 0), null);
  assert.equal(finalStatementBlocker("final", "0"), null);
});

test("finalStatementBlocker: a negative figure is an answer too", () => {
  // A seller in arrears credits the buyer.
  assert.equal(finalStatementBlocker("final", -412.9), null);
});

// ── the rule against what the parser actually produces ────────────────

test("finalStatementBlocker: blocks the payload a blank form sends", () => {
  const parsed = parseEstimatePayload({
    purchase_price: 1_080_000,
    statement_type: "final",
    // property_tax_adjustment omitted entirely — a cleared field
  });
  assert.ok("payload" in parsed);
  assert.equal(parsed.payload.property_tax_adjustment, null);
  assert.ok(
    finalStatementBlocker(parsed.payload.statement_type, parsed.payload.property_tax_adjustment),
  );
});

test("finalStatementBlocker: passes the payload a completed form sends", () => {
  const parsed = parseEstimatePayload({
    purchase_price: 1_080_000,
    statement_type: "final",
    property_tax_adjustment: 1487.22,
  });
  assert.ok("payload" in parsed);
  assert.equal(
    finalStatementBlocker(
      parsed.payload.statement_type,
      parsed.payload.property_tax_adjustment,
    ),
    null,
  );
});

// ── the adjustment reaches the balance, not the total ─────────────────

test("a final account's adjustment lands on the balance, outside total closing costs", () => {
  const parsed = parseEstimatePayload({
    purchase_price: 1_080_000,
    deposit_paid: 50_000,
    mortgage_amount: 800_000,
    statement_type: "final",
    property_tax_adjustment: 1_000,
  });
  assert.ok("payload" in parsed);

  const withAdjustment = buildEstimateRow(
    parsed.payload,
    {},
    defaultStatementType("final"),
  );
  const withoutAdjustment = buildEstimateRow(
    { ...parsed.payload, property_tax_adjustment: null },
    {},
    defaultStatementType("final"),
  );

  // The fee total is untouched by it…
  assert.equal(withAdjustment.statement.total, withoutAdjustment.statement.total);
  // …and the client's balance is exactly $1,000 higher.
  assert.equal(
    withAdjustment.statement.balance.balanceDue -
      withoutAdjustment.statement.balance.balanceDue,
    1_000,
  );
});

// ── the freeze carries the flavour that was gated ─────────────────────

test("buildEstimateRow: a final account freezes the final wording", () => {
  const parsed = parseEstimatePayload({
    purchase_price: 1_080_000,
    statement_type: "final",
    property_tax_adjustment: 900,
  });
  assert.ok("payload" in parsed);

  const { columns } = buildEstimateRow(parsed.payload, {}, defaultStatementType("final"));
  const snapshot = columns.config_snapshot as {
    statement_type: Record<string, unknown>;
  };
  assert.equal(snapshot.statement_type.type_key, "final");
  // A final account carries no DRAFT watermark — that is the whole difference
  // the gate above is protecting.
  assert.equal(snapshot.statement_type.show_watermark, false);
  assert.match(String(columns.config_version), /^v\d+\.[0-9a-f]{8}$/);
});
