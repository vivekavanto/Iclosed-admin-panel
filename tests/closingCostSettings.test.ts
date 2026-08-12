// Unit tests for the firm / shared-rate split behind the closing-cost settings
// page. Run with:  npm test
//
// The load-bearing assertion is `merge of the defaults === DEFAULT_RATES`: it is
// the proof that splitting one config row into "per-firm" and "shared" changed
// no client-facing number. If it fails, the split has leaked into the maths.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RATES,
  ratesFromConfigRow,
  type Tier,
} from "../src/lib/closingCosts.ts";
import {
  FIRM_KEYS,
  FALLBACK_FIRM_KEY,
  LETTERHEAD_COLUMNS,
  SHARED_RATE_COLUMNS,
  defaultFirmRow,
  defaultSharedRow,
  defaultStatementType,
  hexColorError,
  hexToRgb01,
  isFirmKey,
  isStatementTypeKey,
  mergeConfigRow,
  statementTypeFromRow,
  tierError,
  toFirmKey,
} from "../src/lib/closingCostSettings.ts";

// ── the split changed no number ────────────────────────────────────────
test("merging the code defaults reproduces DEFAULT_RATES exactly", () => {
  for (const key of FIRM_KEYS) {
    const merged = mergeConfigRow(defaultFirmRow(key), defaultSharedRow(), key);
    assert.deepEqual(
      ratesFromConfigRow(merged),
      DEFAULT_RATES,
      `${key} defaults must produce the unchanged rate set`,
    );
  }
});

test("both firms quote identical figures until their fees are edited", () => {
  const shared = defaultSharedRow();
  const a = ratesFromConfigRow(mergeConfigRow(defaultFirmRow("navawilson"), shared, "navawilson"));
  const b = ratesFromConfigRow(mergeConfigRow(defaultFirmRow("iclosed"), shared, "iclosed"));
  assert.deepEqual(a, b);
});

// ── merge shape ────────────────────────────────────────────────────────
test("a merged row carries every key ratesFromConfigRow and the PDF read", () => {
  const merged = mergeConfigRow(null, null, FALLBACK_FIRM_KEY);
  const rateColumns = [
    ...SHARED_RATE_COLUMNS,
    "legal_fees",
    "legal_title_submission",
    "admin_fee",
    "teraview",
    "sheriff",
  ];
  for (const key of [...rateColumns, ...LETTERHEAD_COLUMNS]) {
    assert.ok(key in merged, `merged row is missing ${key}`);
    assert.notEqual(merged[key], undefined, `${key} must not be undefined`);
  }
  assert.equal(merged.firm_key, FALLBACK_FIRM_KEY);
});

test("shared beats a legacy statutory value still sitting on the firm row", () => {
  const merged = mergeConfigRow(
    { hst_rate: 0.15, admin_fee: 275 },
    { hst_rate: 0.13 },
    "navawilson",
  );
  assert.equal(merged.hst_rate, 0.13, "shared rates are the single source of truth");
  assert.equal(merged.admin_fee, 275, "a firm fee is untouched by the shared row");
});

test("the shared row's own metadata never clobbers the firm's", () => {
  const merged = mergeConfigRow(
    { id: "firm-id", label: "Nava Wilson", updated_at: "2026-08-01" },
    { id: "shared-id", label: "Statutory", updated_at: "2026-08-02" },
    "navawilson",
  );
  assert.equal(merged.id, "firm-id");
  assert.equal(merged.label, "Nava Wilson");
  assert.equal(merged.updated_at, "2026-08-01");
});

test("a null/undefined shared value falls through to the firm row", () => {
  const merged = mergeConfigRow({ hst_rate: 0.14 }, { hst_rate: null }, "navawilson");
  assert.equal(merged.hst_rate, 0.14);
});

test("iClosed inherits the division letterhead but not the identity", () => {
  const nava = defaultFirmRow("navawilson");
  const iclosed = defaultFirmRow("iclosed");
  assert.equal(iclosed.firm_address, nava.firm_address);
  assert.equal(iclosed.firm_hst_number, nava.firm_hst_number);
  assert.notEqual(iclosed.firm_name, nava.firm_name);
  assert.notEqual(iclosed.brand_color, nava.brand_color);
});

test("only the incumbent firm is active by default", () => {
  assert.equal(defaultFirmRow("navawilson").is_active, true);
  assert.equal(
    defaultFirmRow("iclosed").is_active,
    false,
    "a second active row would break the pre-deploy .maybeSingle() read",
  );
});

// ── key guards ─────────────────────────────────────────────────────────
test("firm and statement-type keys are guarded", () => {
  assert.ok(isFirmKey("iclosed"));
  assert.ok(isFirmKey("navawilson"));
  assert.equal(isFirmKey("other"), false);
  assert.equal(isFirmKey(null), false);
  assert.equal(toFirmKey("nope"), FALLBACK_FIRM_KEY);
  assert.equal(toFirmKey("iclosed"), "iclosed");

  assert.ok(isStatementTypeKey("draft"));
  assert.ok(isStatementTypeKey("final"));
  assert.equal(isStatementTypeKey("issued"), false);
});

// ── statement types ────────────────────────────────────────────────────
test("statement-type defaults preserve today's hard-coded strings", () => {
  const draft = defaultStatementType("draft");
  assert.equal(draft.title, "ESTIMATED CLOSING COSTS");
  assert.equal(draft.screen_heading, "ESTIMATED STATEMENT OF ACCOUNT");
  assert.equal(draft.show_watermark, true);
  assert.equal(defaultStatementType("final").show_watermark, false);
});

test("statementTypeFromRow fills gaps but keeps a cleared footer note cleared", () => {
  const d = defaultStatementType("draft");
  const filled = statementTypeFromRow({ title: "   ", footer_note: "" }, "draft");
  assert.equal(filled.title, d.title, "a blank title falls back");
  assert.equal(filled.footer_note, "", "an empty footer note is a real choice");

  const overridden = statementTypeFromRow(
    { title: "MY TITLE", show_watermark: false },
    "draft",
  );
  assert.equal(overridden.title, "MY TITLE");
  assert.equal(overridden.show_watermark, false);
});

// ── validators ─────────────────────────────────────────────────────────
test("hexColorError accepts 6-digit hex only", () => {
  assert.equal(hexColorError("Brand colour", "#C10007"), null);
  assert.equal(hexColorError("Brand colour", "#ce2028"), null);
  for (const bad of ["#C10", "C10007", "red", "", "#GGGGGG", null, 12]) {
    assert.notEqual(
      hexColorError("Brand colour", bad),
      null,
      `${String(bad)} should be rejected`,
    );
  }
});

test("hexToRgb01 parses channels and falls back on junk", () => {
  const fallback = { r: 1, g: 0, b: 0 };
  assert.deepEqual(hexToRgb01("#000000", fallback), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb01("#FFFFFF", fallback), { r: 1, g: 1, b: 1 });
  assert.deepEqual(hexToRgb01("nope", fallback), fallback);

  const brand = hexToRgb01("#CE2028", fallback);
  assert.equal(brand.r, 0xce / 255, "matches the red the PDF has always printed");
  assert.equal(brand.g, 0x20 / 255);
  assert.equal(brand.b, 0x28 / 255);
});

test("tierError enforces a usable marginal bracket table", () => {
  const good: Tier[] = [
    [55000, 0.005],
    [null, 0.025],
  ];
  assert.equal(tierError("LTT", good), null);

  assert.notEqual(tierError("LTT", "not an array"), null);
  assert.notEqual(tierError("LTT", []), null);
  assert.notEqual(
    tierError("LTT", [[55000, 0.005]]),
    null,
    "a capped last band silently under-taxes every price above it",
  );
  assert.notEqual(
    tierError("LTT", [
      [250000, 0.01],
      [55000, 0.005],
      [null, 0.02],
    ]),
    null,
    "caps must increase",
  );
  assert.notEqual(
    tierError("LTT", [
      [55000, 1.5],
      [null, 0.02],
    ]),
    null,
    "a rate above 1 is a percentage entered as a rate",
  );
  assert.notEqual(
    tierError("LTT", [
      [null, 0.01],
      [null, 0.02],
    ]),
    null,
    "only the last band may be open-ended",
  );
});
