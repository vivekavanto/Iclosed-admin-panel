// The presentation half of an estimate's frozen configuration.
//
// The rule these tests defend is the one Settings → Closing costs states on
// screen: "Changing these affects new estimates only — an estimate already
// issued keeps the figures the client was sent." Freezing `rates_used` honoured
// that for the numbers only; the letterhead and the wording were read live at
// render time, so editing a disclaimer rewrote every statement already sent.

import assert from "node:assert/strict";
import test from "node:test";

import {
  PRESENTATION_COLUMNS,
  buildConfigSnapshot,
  configFromSnapshot,
  configVersionOf,
  isConfigSnapshot,
} from "../src/lib/closingCostConfigSnapshot.ts";
import { DEFAULT_RATES } from "../src/lib/closingCosts.ts";
import { defaultStatementType } from "../src/lib/closingCostSettings.ts";

const CONFIG = {
  firm_key: "navawilson",
  label: "Nava Wilson",
  firm_badge: "NAVA WILSON PC",
  brand_color: "#CE2028",
  logo_url: "https://blob.example/logo.png",
  firm_name: "NAVA WILSON PROFESSIONAL CORPORATION",
  firm_subtitle: "Barristers and Solicitors",
  firm_address: "Suite 210, 10 Milner Business Court, Toronto, Ontario, M1B 3C6",
  firm_phone: "416-321-1100",
  firm_fax: "416-321-1107",
  firm_hst_number: "829252303RT0001",
  // Rates live in `rates_used`, not here — they must NOT be duplicated.
  legal_fees: 1200,
  admin_fee: 250,
  hst_rate: 0.13,
};

const DRAFT = defaultStatementType("draft");
const FINAL = defaultStatementType("final");

// ── what gets frozen ──────────────────────────────────────────────────

test("buildConfigSnapshot: captures every letterhead and brand field", () => {
  const snap = buildConfigSnapshot(CONFIG, DRAFT);
  for (const key of PRESENTATION_COLUMNS) {
    assert.equal(
      snap.firm[key],
      CONFIG[key as keyof typeof CONFIG],
      `${key} was not frozen`,
    );
  }
});

test("buildConfigSnapshot: does NOT duplicate the rates", () => {
  const snap = buildConfigSnapshot(CONFIG, DRAFT);
  // Two copies of a fee that could drift apart is worse than one.
  assert.equal(snap.firm.legal_fees, undefined);
  assert.equal(snap.firm.admin_fee, undefined);
  assert.equal(snap.firm.hst_rate, undefined);
});

test("buildConfigSnapshot: captures the whole statement-type copy", () => {
  const snap = buildConfigSnapshot(CONFIG, FINAL);
  assert.equal(snap.statement_type.type_key, "final");
  assert.equal(snap.statement_type.title, FINAL.title);
  assert.equal(snap.statement_type.screen_heading, FINAL.screen_heading);
  assert.equal(snap.statement_type.disclaimer_intro, FINAL.disclaimer_intro);
  assert.equal(snap.statement_type.show_watermark, false);
});

test("buildConfigSnapshot: a deliberately-cleared field stays cleared", () => {
  // An empty fax line is a choice, not a gap — a re-render must not resurrect
  // the default just because the value is falsy.
  const snap = buildConfigSnapshot({ ...CONFIG, firm_fax: "" }, DRAFT);
  assert.equal(snap.firm.firm_fax, "");
});

test("buildConfigSnapshot: no config and no type still yields a usable snapshot", () => {
  const snap = buildConfigSnapshot(null, null);
  assert.deepEqual(snap.firm, {});
  assert.equal(snap.statement_type.type_key, "draft");
});

// ── rendering back ────────────────────────────────────────────────────

test("configFromSnapshot: round-trips the letterhead and the wording", () => {
  const restored = configFromSnapshot(buildConfigSnapshot(CONFIG, FINAL));
  assert.ok(restored);
  assert.equal(restored.config.firm_name, CONFIG.firm_name);
  assert.equal(restored.config.brand_color, CONFIG.brand_color);
  assert.equal(restored.statementType.type_key, "final");
  assert.equal(restored.statementType.title, FINAL.title);
  assert.equal(restored.statementType.show_watermark, false);
});

test("configFromSnapshot: a settings edit cannot reach an issued estimate", () => {
  // The document is issued under today's wording…
  const snapshot = buildConfigSnapshot(CONFIG, DRAFT);
  const asIssued = configFromSnapshot(snapshot);

  // …and staff then rewrite the disclaimer and rebrand the firm.
  const edited = buildConfigSnapshot(
    { ...CONFIG, brand_color: "#00FF00", firm_name: "SOMETHING ELSE" },
    { ...DRAFT, disclaimer_intro: "Completely different wording." },
  );

  assert.ok(asIssued);
  assert.equal(asIssued.config.firm_name, "NAVA WILSON PROFESSIONAL CORPORATION");
  assert.equal(asIssued.statementType.disclaimer_intro, DRAFT.disclaimer_intro);
  // The live config did move — the frozen one simply did not follow it.
  assert.equal(edited.firm.firm_name, "SOMETHING ELSE");
});

test("configFromSnapshot: null for anything that is not a snapshot", () => {
  // The signal to fall back to the live config, for rows written before the
  // 2026-08-08 migration.
  assert.equal(configFromSnapshot(null), null);
  assert.equal(configFromSnapshot(undefined), null);
  assert.equal(configFromSnapshot({}), null);
  assert.equal(configFromSnapshot("nope"), null);
  assert.equal(isConfigSnapshot({ firm: {} }), true);
});

test("configFromSnapshot: a snapshot missing a field falls back, never prints undefined", () => {
  const restored = configFromSnapshot({ firm: {}, statement_type: { type_key: "draft" } });
  assert.ok(restored);
  assert.equal(restored.statementType.title, DRAFT.title);
  assert.equal(restored.statementType.watermark_text, "DRAFT");
});

// ── the version stamp ─────────────────────────────────────────────────

test("configVersionOf: stable across key order and repeated calls", () => {
  const a = configVersionOf(DEFAULT_RATES, buildConfigSnapshot(CONFIG, DRAFT));
  const reordered = Object.fromEntries(
    Object.entries(CONFIG).reverse(),
  ) as typeof CONFIG;
  const b = configVersionOf(DEFAULT_RATES, buildConfigSnapshot(reordered, DRAFT));
  assert.equal(a, b);
});

test("configVersionOf: carries the calc version", () => {
  const stamp = configVersionOf(DEFAULT_RATES, buildConfigSnapshot(CONFIG, DRAFT));
  assert.match(stamp, /^v\d+\.[0-9a-f]{8}$/);
});

test("configVersionOf: moves when a rate moves", () => {
  const before = configVersionOf(DEFAULT_RATES, buildConfigSnapshot(CONFIG, DRAFT));
  const after = configVersionOf(
    { ...DEFAULT_RATES, adminFee: 275 },
    buildConfigSnapshot(CONFIG, DRAFT),
  );
  assert.notEqual(before, after);
});

test("configVersionOf: the cross-repo golden stamp", () => {
  // The customer portal carries a twin of this module and stamps its own PDFs
  // with it. If the two implementations ever drift, the SAME configuration
  // would be labelled two different ways and the stamp would stop meaning
  // anything. Pinning one known value in both suites is what catches that: the
  // mirror of this assertion lives in the portal at
  // src/lib/__tests__/closingCostConfigSnapshot.test.ts.
  //
  // A change here is only correct if it is made there in the same breath.
  const snapshot = buildConfigSnapshot(
    { firm_key: "navawilson", label: "Nava Wilson", firm_name: "ACME" },
    DRAFT,
  );
  // Moved from v7.64b1ee0e on 2026-08-12, when the statement title lost its
  // "— RESIDENTIAL PURCHASE (ONTARIO)" qualifier, and from v7.c92cbeb6 on
  // 2026-08-18, when Toronto's graduated MLTT rates took effect — a rate change
  // is exactly what this stamp exists to distinguish. `DRAFT` is the default
  // statement type, so a wording edit there moves it too.
  assert.equal(configVersionOf(DEFAULT_RATES, snapshot), "v7.5d7e2998");
});

test("configVersionOf: moves when only the presentation moves", () => {
  // The whole point: a wording-only edit is still a different document, so it
  // must not carry the stamp of the one that came before it.
  const before = configVersionOf(DEFAULT_RATES, buildConfigSnapshot(CONFIG, DRAFT));
  const rebranded = configVersionOf(
    DEFAULT_RATES,
    buildConfigSnapshot({ ...CONFIG, brand_color: "#000000" }, DRAFT),
  );
  const reworded = configVersionOf(
    DEFAULT_RATES,
    buildConfigSnapshot(CONFIG, { ...DRAFT, disclaimer_intro: "New wording." }),
  );
  assert.notEqual(before, rebranded);
  assert.notEqual(before, reworded);
  assert.notEqual(rebranded, reworded);
});
