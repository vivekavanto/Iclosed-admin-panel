// Unit tests for the purchase closing-cost maths. Run with:  npm test
//
// Every expected figure below is taken from the requirements document's worked
// examples or from the approved mock-up, so this file is the contract: if a
// number here changes, the client-facing statement changed.
//
// The same cases exist in the customer portal repo
// (d:\iclosed_dev_web\src\lib\__tests__\closingCosts.test.ts) — that is how a
// one-sided edit to the twin closingCosts.ts module gets caught.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CALC_VERSION,
  DEFAULT_RATES,
  computeStatement,
  formatRatePercent,
  isTierArray,
  provincialLTT,
  ratesFromConfigRow,
  round2,
  titlePremiumEstimate,
  torontoMLTT,
  type ClosingCostInputs,
  type Statement,
} from "../src/lib/closingCosts.ts";

// ── helpers ────────────────────────────────────────────────────────────
/** Flat map of line key → amount across every group. */
function lines(s: Statement): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of s.groups) for (const l of g.lines) out[l.key] = l.amount;
  return out;
}

function lineKeys(s: Statement): string[] {
  return s.groups.flatMap((g) => g.lines.map((l) => l.key));
}

function findLine(s: Statement, key: string) {
  return s.groups.flatMap((g) => g.lines).find((l) => l.key === key);
}

/** The mock-up's reference file: $1.08M, $50k down, $399,700 mortgage. */
const REFERENCE: ClosingCostInputs = {
  price: 1_080_000,
  deposit: 50_000,
  mortgage: 399_700,
  isToronto: false,
  isFirstTimeBuyer: false,
};

// ── round2 ─────────────────────────────────────────────────────────────
test("round2: half away from zero, cents precision", () => {
  assert.equal(round2(232.492), 232.49);
  assert.equal(round2(160.992), 160.99);
  assert.equal(round2(12.345), 12.35);
  assert.equal(round2(-12.345), -12.35);
  assert.equal(round2(0.13 * 1788.4), 232.49);
  assert.equal(round2(0), 0);
  assert.equal(round2(Number.NaN), 0);
  assert.equal(round2(Infinity), 0);
});

// ── Ontario provincial LTT (marginal tiers) ────────────────────────────
test("provincialLTT: tier boundaries", () => {
  assert.equal(provincialLTT(0), 0);
  assert.equal(provincialLTT(-100), 0);
  // 55,000 × 0.5%
  assert.equal(provincialLTT(55_000), 275);
  // 275 + 195,000 × 1%
  assert.equal(provincialLTT(250_000), 2225);
  // + 150,000 × 1.5%
  assert.equal(provincialLTT(400_000), 4475);
  // + 1,600,000 × 2%
  assert.equal(provincialLTT(2_000_000), 36_475);
  // + 500,000 × 2.5% (top open-ended band)
  assert.equal(provincialLTT(2_500_000), 48_975);
});

test("provincialLTT: the document's worked example", () => {
  // 275 + 1,950 + 2,250 + 13,600 = 18,075.00
  assert.equal(provincialLTT(1_080_000), 18_075);
});

// ── Toronto municipal LTT ──────────────────────────────────────────────
test("torontoMLTT: identical to provincial at or below $2M", () => {
  for (const p of [0, 55_000, 250_000, 400_000, 1_080_000, 2_000_000]) {
    assert.equal(torontoMLTT(p), provincialLTT(p), `mismatch at ${p}`);
  }
});

test("torontoMLTT: still equal to provincial through $3M", () => {
  // Not a coincidence worth relying on, but worth pinning: the provincial
  // table's top open-ended band is 2.5%, which is exactly Toronto's $2M–$3M
  // band. The two only diverge ABOVE $3M, where Toronto's 3.5%+ luxury tiers
  // start. Anyone "fixing" a test that expects Toronto > provincial at $3M
  // should change the test, not the brackets.
  assert.equal(torontoMLTT(2_500_000), provincialLTT(2_500_000));
  assert.equal(torontoMLTT(3_000_000), provincialLTT(3_000_000));
  assert.ok(torontoMLTT(4_000_000) > provincialLTT(4_000_000));
  assert.ok(torontoMLTT(25_000_000) > provincialLTT(25_000_000));
});

test("torontoMLTT: luxury tiers above $2M", () => {
  // 36,475 + 1,000,000 × 2.5%
  assert.equal(torontoMLTT(3_000_000), 61_475);
  // + 1,000,000 × 3.5%
  assert.equal(torontoMLTT(4_000_000), 96_475);
  // + 1,000,000 × 4.5%
  assert.equal(torontoMLTT(5_000_000), 141_475);
  // + 5,000,000 × 5.5%
  assert.equal(torontoMLTT(10_000_000), 416_475);
  // + 10,000,000 × 6.5%
  assert.equal(torontoMLTT(20_000_000), 1_066_475);
  // + 5,000,000 × 7.5% (top open-ended band)
  assert.equal(torontoMLTT(25_000_000), 1_441_475);
});

// ── FCT title premium ──────────────────────────────────────────────────
test("titlePremiumEstimate: linear above the floor, floored below", () => {
  assert.equal(titlePremiumEstimate(0), 0);
  assert.equal(titlePremiumEstimate(-5), 0);
  // 250 + 1,080,000 × 0.0785% = 250 + 847.80
  assert.equal(round2(titlePremiumEstimate(1_080_000)), 1097.8);
  // 250 + 39.25 = 289.25 → floored at the 300 minimum premium
  assert.equal(titlePremiumEstimate(50_000), 300);

  // The floor stops engaging at price = (300 − 250) / 0.000785 ≈ $63,694.27.
  // Just below the crossover the linear value (299.46) loses to the floor;
  // just above it, the linear formula governs.
  assert.equal(titlePremiumEstimate(63_000), 300);
  assert.equal(round2(titlePremiumEstimate(64_000)), 300.24);
  assert.ok(titlePremiumEstimate(70_000) > 300);
  assert.equal(round2(titlePremiumEstimate(70_000)), 304.95);
});

// ── First-time buyer rebates ───────────────────────────────────────────
test("rebates: none unless first-time buyer", () => {
  const s = computeStatement(REFERENCE);
  assert.equal(s.detail.ontarioRebate, 0);
  assert.equal(s.detail.torontoRebate, 0);
  assert.ok(!lineKeys(s).includes("rebate_ontario"));
  assert.ok(!lineKeys(s).includes("rebate_toronto"));
});

test("rebates: Ontario only outside Toronto", () => {
  const s = computeStatement({ ...REFERENCE, isFirstTimeBuyer: true });
  assert.equal(s.detail.ontarioRebate, 4000);
  assert.equal(s.detail.torontoRebate, 0);
  assert.equal(lines(s).rebate_ontario, -4000);
  assert.ok(!lineKeys(s).includes("rebate_toronto"));
});

test("rebates: both in Toronto, each capped", () => {
  const s = computeStatement({
    ...REFERENCE,
    isToronto: true,
    isFirstTimeBuyer: true,
  });
  assert.equal(s.detail.ontarioRebate, 4000);
  assert.equal(s.detail.torontoRebate, 4475);
  assert.equal(lines(s).rebate_ontario, -4000);
  assert.equal(lines(s).rebate_toronto, -4475);
  // netLTT = 18,075 + 18,075 − 4,000 − 4,475
  assert.equal(s.detail.netLTT, 27_675);
});

test("rebates: capped by the tax itself on a cheap property", () => {
  // A $150,000 purchase pays only 1,225 in provincial LTT, so the rebate can
  // never exceed that — it reduces the tax, it is not a cash payment.
  const s = computeStatement({
    price: 150_000,
    deposit: 0,
    mortgage: 0,
    isToronto: true,
    isFirstTimeBuyer: true,
  });
  assert.equal(s.detail.provincialLTT, 1225);
  assert.equal(s.detail.ontarioRebate, 1225);
  assert.equal(s.detail.torontoRebate, 1225);
  assert.equal(s.detail.netLTT, 0);
});

// ── The reference statement (mock-up figures, to the cent) ─────────────
test("computeStatement: the reference file matches the mock-up exactly", () => {
  const s = computeStatement(REFERENCE);
  const l = lines(s);

  assert.equal(l.ltt_provincial, 18_075);
  assert.equal(l.title_premium, 1097.8);
  assert.equal(l.reg_transfer, 85);
  assert.equal(l.reg_mortgage, 85);
  assert.equal(l.teraview, 54.8);
  assert.equal(l.sheriff, 133.6);
  assert.equal(l.legal_fees, 1350);
  assert.equal(l.admin_fee, 250);

  // HST on legal + admin + Teraview + Sheriff only: 13% × 1,788.40
  assert.equal(s.detail.taxableBase, 1788.4);
  assert.equal(s.hst.amount, 232.49);

  assert.equal(s.total, 21_363.69);
  assert.equal(s.balance.balanceDue, 651_663.69);
});

test("computeStatement: printed lines sum to the printed total", () => {
  // The whole point of rounding each line and summing the rounded values.
  for (const inputs of [
    REFERENCE,
    { ...REFERENCE, isToronto: true, isFirstTimeBuyer: true },
    { ...REFERENCE, mortgage: 0 },
    { price: 333_333.33, deposit: 11_111.11, mortgage: 222_222.22, isToronto: true, isFirstTimeBuyer: false },
  ] as ClosingCostInputs[]) {
    const s = computeStatement(inputs);
    const sum = round2(
      s.groups.reduce((acc, g) => acc + g.lines.reduce((a, x) => a + x.amount, 0), 0) +
        s.hst.amount,
    );
    assert.equal(sum, s.total, `lines do not tie to the total for ${JSON.stringify(inputs)}`);

    const balance = round2(
      s.balance.purchasePrice -
        s.balance.depositPaid -
        s.balance.mortgageAmount +
        s.balance.closingCosts,
    );
    assert.equal(balance, s.balance.balanceDue);
  }
});

// ── Cash purchase behaviour ────────────────────────────────────────────
test("computeStatement: cash purchase drops both mortgage items", () => {
  const s = computeStatement({ ...REFERENCE, mortgage: 0 });
  const l = lines(s);

  // "Registration of Mortgage" is gone entirely, not zeroed
  assert.ok(!lineKeys(s).includes("reg_mortgage"));
  // Legal fees fall to transfer + title submission
  assert.equal(l.legal_fees, 800);
  assert.equal(findLine(s, "legal_fees")?.sublabel, "purchase & title submission");
  // HST base = 800 + 250 + 54.80 + 133.60 = 1,238.40 → 13% = 160.992
  assert.equal(s.detail.taxableBase, 1238.4);
  assert.equal(s.hst.amount, 160.99);
  // 18,075 + 1,097.80 + 85 + 54.80 + 133.60 + 800 + 250 + 160.99
  assert.equal(s.total, 20_657.19);
  // 1,080,000 − 50,000 − 0 + 20,657.19
  assert.equal(s.balance.balanceDue, 1_050_657.19);
});

// ── Toronto toggle ─────────────────────────────────────────────────────
test("computeStatement: municipal LTT line only in Toronto", () => {
  const outside = computeStatement(REFERENCE);
  assert.ok(!lineKeys(outside).includes("ltt_municipal"));
  assert.equal(outside.detail.municipalLTT, 0);

  const inside = computeStatement({ ...REFERENCE, isToronto: true });
  assert.equal(lines(inside).ltt_municipal, 18_075);
  // Toronto costs exactly one more provincial-equivalent LTT at this price
  assert.equal(round2(inside.total - outside.total), 18_075);
});

// ── Title premium override ─────────────────────────────────────────────
test("computeStatement: override is used verbatim and drops the ESTIMATE badge", () => {
  const estimated = computeStatement(REFERENCE);
  assert.equal(findLine(estimated, "title_premium")?.badge, "ESTIMATE");
  assert.equal(estimated.detail.titlePremiumIsEstimate, true);

  const overridden = computeStatement({ ...REFERENCE, titlePremiumOverride: 950 });
  assert.equal(lines(overridden).title_premium, 950);
  assert.equal(findLine(overridden, "title_premium")?.badge, undefined);
  assert.equal(overridden.detail.titlePremiumIsEstimate, false);
  // HST is NOT charged on the title premium, so the total moves by exactly the
  // premium difference.
  assert.equal(round2(estimated.total - overridden.total), round2(1097.8 - 950));

  // An explicit zero is a real override (some files carry no title insurance),
  // not "fall back to the estimate".
  const zeroed = computeStatement({ ...REFERENCE, titlePremiumOverride: 0 });
  assert.equal(lines(zeroed).title_premium, 0);
  assert.equal(zeroed.detail.titlePremiumIsEstimate, false);

  // null / undefined mean "use the estimate"
  assert.equal(
    computeStatement({ ...REFERENCE, titlePremiumOverride: null }).detail
      .titlePremiumIsEstimate,
    true,
  );
});

// ── Group ordering & structure ─────────────────────────────────────────
test("computeStatement: four groups in the required order", () => {
  const s = computeStatement(REFERENCE);
  assert.deepEqual(
    s.groups.map((g) => g.key),
    ["ltt", "title", "third_party", "legal"],
  );
  assert.deepEqual(
    s.groups.map((g) => g.title),
    ["Land Transfer Tax", "Title Insurance", "Third-Party Disbursements", "Legal & Admin Fees"],
  );
  assert.equal(s.calcVersion, CALC_VERSION);
  assert.equal(s.hst.label, "HST @ 13% on taxable fees & disbursements");
});

test("computeStatement: zero price yields a zero-ish statement, not NaN", () => {
  const s = computeStatement({
    price: 0,
    deposit: 0,
    mortgage: 0,
    isToronto: false,
    isFirstTimeBuyer: false,
  });
  assert.equal(s.detail.provincialLTT, 0);
  assert.equal(s.detail.titlePremium, 0);
  // The firm's own fees still apply
  assert.equal(lines(s).legal_fees, 800);
  assert.ok(Number.isFinite(s.total));
  assert.ok(Number.isFinite(s.balance.balanceDue));
});

test("computeStatement: negative inputs are clamped to zero", () => {
  const s = computeStatement({
    price: -1000,
    deposit: -50,
    mortgage: -10,
    isToronto: false,
    isFirstTimeBuyer: false,
  });
  assert.equal(s.balance.purchasePrice, 0);
  assert.equal(s.balance.depositPaid, 0);
  assert.equal(s.balance.mortgageAmount, 0);
  assert.ok(!lineKeys(s).includes("reg_mortgage"));
});

// ── Config-driven rates ────────────────────────────────────────────────
test("ratesFromConfigRow: maps a DB row, falling back per field", () => {
  const rates = ratesFromConfigRow({
    admin_fee: "300",           // numeric arrives as a string from Postgres
    hst_rate: 0.15,
    legal_transfer: 700,
    ltt_tiers: [[100000, 0.01], [null, 0.02]],
    mltt_tiers: "not an array", // malformed → default
    teraview: null,             // null → default
  });
  assert.equal(rates.adminFee, 300);
  assert.equal(rates.hstRate, 0.15);
  assert.equal(rates.legalTransfer, 700);
  assert.deepEqual(rates.lttTiers, [[100000, 0.01], [null, 0.02]]);
  assert.deepEqual(rates.mlttTiers, DEFAULT_RATES.mlttTiers);
  assert.equal(rates.teraview, DEFAULT_RATES.teraview);
  // A missing row falls back wholesale
  assert.deepEqual(ratesFromConfigRow(null), DEFAULT_RATES);
});

test("computeStatement: honours edited config rates", () => {
  const rates = { ...DEFAULT_RATES, adminFee: 500, hstRate: 0.15 };
  const s = computeStatement(REFERENCE, rates);
  assert.equal(lines(s).admin_fee, 500);
  // base = 1,350 + 500 + 54.80 + 133.60 = 2,038.40 → 15% = 305.76
  assert.equal(s.detail.taxableBase, 2038.4);
  assert.equal(s.hst.amount, 305.76);
  assert.equal(s.hst.label, "HST @ 15% on taxable fees & disbursements");
});

test("computeStatement: honours edited LTT brackets", () => {
  // A flat 1% bracket table
  const rates = { ...DEFAULT_RATES, lttTiers: [[null, 0.01]] as [number | null, number][] };
  const s = computeStatement(REFERENCE, rates);
  assert.equal(lines(s).ltt_provincial, 10_800);
});

test("isTierArray / formatRatePercent", () => {
  assert.ok(isTierArray([[55000, 0.005], [null, 0.025]]));
  assert.ok(!isTierArray([]));
  assert.ok(!isTierArray([[55000]]));
  assert.ok(!isTierArray([["55000", 0.005]]));
  assert.ok(!isTierArray("nope"));
  assert.ok(!isTierArray([[55000, 0.005], [null, null]]));

  assert.equal(formatRatePercent(0.13), "13%");
  assert.equal(formatRatePercent(0.125), "12.5%");
  assert.equal(formatRatePercent(0), "0%");
});
