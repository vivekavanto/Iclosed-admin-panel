// Purchase closing-cost calculation — the single source of truth for every
// figure the calculator shows, on screen, in the saved snapshot, and in the PDF.
//
// PURE by design: no Supabase, no React, no `window`, no Date. It runs
// unchanged in a route handler, in the browser on every keystroke, and in
// `tests/closingCosts.test.ts`. That is what lets the client render live totals
// while the server independently recomputes the authoritative ones on save —
// same input, same module, same numbers.
//
// ⚠️ TWIN FILE. An identical copy lives in the customer portal repo at
//    d:\iclosed_dev_web\src\lib\closingCosts.ts
// Any edit here MUST be applied there too, and vice versa. The same test cases
// run in both repos so a one-sided edit fails that repo's suite. CALC_VERSION
// is stamped into every saved snapshot, so a drift is also detectable in data.
//
// Rates are NOT constants — they come from the `closing_cost_config` table via
// ratesFromConfigRow(). DEFAULT_RATES exists only as a fallback that mirrors the
// SQL column defaults, so the calculator still works if the config row is
// missing or unreachable.

/**
 * Bumped whenever the shape of a Statement or the maths changes.
 *
 * 2 — added the optional "Property Tax" group (propertyTaxAdjustment). Purely
 *     additive: with no adjustment the statement is identical to a v1 one.
 * 3 — "FCT — submission & review" became its own line under Title Insurance
 *     instead of being folded into "Legal fees". Presentation only: the HST
 *     base, the total and the balance are all unchanged.
 * 4 — the firm's legal fee became ONE `legal_fees` amount instead of a
 *     transfer + mortgage pair. NOT presentation-only: a cash purchase used to
 *     be charged the transfer portion alone and is now charged the same legal
 *     fee as a mortgage purchase, so its total moves.
 * 5 — land transfer tax accepts a per-file dollar override, replacing the
 *     bracket calculation. Additive: with no override supplied a v5 statement
 *     is identical to a v4 one.
 * 6 — the Sheriff's Certificates line carries a sublabel saying what the search
 *     is for. Presentation only, and only on the PDF — the screens do not draw
 *     sublabels — so every figure, subtotal and total is unchanged from v5.
 * 7 — the ESTIMATE badge is decided HERE for every provisional line, not by
 *     each surface. Teraview, the Sheriff's searches and the Statement of
 *     Adjustments figure now carry it exactly as the title premium already did,
 *     and `isFinalAccount` suppresses all four. Presentation only; no figure
 *     moves. Before this the two screens each added their own badges and the
 *     PDF added none, so the same statement disagreed with itself.
 */
export const CALC_VERSION = 7;

/**
 * One marginal tax band: `[cap, rate]`. The rate applies only to the portion of
 * the price between the previous band's cap and this one.
 *
 * A `null` cap means "and above" — JSON has no Infinity, so the final tier is
 * stored as null in jsonb and mapped to Infinity here.
 */
export type Tier = [number | null, number];

export interface ClosingCostRates {
  // Third-party disbursements
  regTransfer: number;
  regMortgage: number;
  teraview: number;
  sheriff: number;
  // Legal & admin fees
  /** One flat professional fee for the purchase, mortgage or not. */
  legalFees: number;
  legalTitleSubmission: number;
  adminFee: number;
  // Rates & caps
  hstRate: number;
  rebateOntarioMax: number;
  rebateTorontoMax: number;
  // FCT title-premium approximation
  titlePremiumBase: number;
  titlePremiumRate: number;
  titlePremiumMin: number;
  // Land transfer tax brackets
  lttTiers: Tier[];
  mlttTiers: Tier[];
}

export interface ClosingCostInputs {
  price: number;
  deposit: number;
  mortgage: number;
  isToronto: boolean;
  isFirstTimeBuyer: boolean;
  /** Non-null = the exact FCT quote, used verbatim; the estimate is skipped. */
  titlePremiumOverride?: number | null;
  /**
   * Non-null = the land transfer tax for this file in dollars, replacing the
   * bracket calculation entirely.
   *
   * The brackets encode a standard residential purchase. Staff need a way out
   * when a file isn't one — a partial interest, a assumed-mortgage
   * consideration, or a ministry reassessment — without editing the bracket
   * table that every other file is priced from.
   *
   * The first-time-buyer rebates cap against the OVERRIDDEN figure, since the
   * rebate refunds the tax actually payable.
   */
  provincialLttOverride?: number | null;
  /** As above, for the Toronto municipal tax. Ignored outside Toronto. */
  municipalLttOverride?: number | null;
  /**
   * The buyer's share of property tax the seller has already paid, from the
   * Statement of Adjustments. Adds a "Property Tax" group when non-zero and is
   * otherwise omitted entirely, so an estimate without one is unchanged.
   *
   * May be negative — a seller who is in arrears credits the buyer instead.
   */
  propertyTaxAdjustment?: number | null;
  /**
   * Suppresses the ESTIMATE badges.
   *
   * Four lines are provisional on a draft — the title premium until First
   * Canadian Title quotes, Teraview and the Sheriff's searches until the file
   * shows how many are needed, and the Statement of Adjustments figure until
   * the seller's lawyer sends it. On a FINAL account those are the charges
   * actually incurred, so calling them estimates would be wrong.
   *
   * Defaults to false — a statement is a draft unless it says otherwise.
   */
  isFinalAccount?: boolean;
}

export interface StatementLine {
  key: string;
  label: string;
  amount: number;
  /** Small print under the label, e.g. what the legal-fees line is made of. */
  sublabel?: string;
  /** e.g. "ESTIMATE" on an auto-calculated title premium. */
  badge?: string;
}

export interface StatementGroup {
  key: string;
  title: string;
  lines: StatementLine[];
}

export interface Statement {
  calcVersion: number;
  groups: StatementGroup[];
  hst: { label: string; amount: number };
  total: number;
  /**
   * The Statement of Adjustments property-tax line, or null when none was
   * entered.
   *
   * Deliberately NOT a member of `groups`: it is not a fee, a tax or a
   * disbursement of the firm, so it must stay out of "Total closing costs" —
   * which is exactly the sum of the group lines plus HST. It is added to the
   * balance separately, after that total.
   */
  propertyTax: StatementLine | null;
  balance: {
    purchasePrice: number;
    depositPaid: number;
    mortgageAmount: number;
    closingCosts: number;
    /** Signed; 0 when no adjustment was entered. */
    propertyTaxAdjustment: number;
    balanceDue: number;
  };
  /** Component figures, handy for the PDF and for assertions. */
  detail: {
    provincialLTT: number;
    municipalLTT: number;
    ontarioRebate: number;
    torontoRebate: number;
    netLTT: number;
    titlePremium: number;
    titlePremiumIsEstimate: boolean;
    legalFees: number;
    registrations: number;
    taxableBase: number;
    /** 0 when no Statement of Adjustments figure has been entered. */
    propertyTaxAdjustment: number;
  };
}

export const DEFAULT_LTT_TIERS: Tier[] = [
  [55000, 0.005],
  [250000, 0.01],
  [400000, 0.015],
  [2000000, 0.02],
  [null, 0.025],
];

export const DEFAULT_MLTT_TIERS: Tier[] = [
  [55000, 0.005],
  [250000, 0.01],
  [400000, 0.015],
  [2000000, 0.02],
  [3000000, 0.025],
  [4000000, 0.035],
  [5000000, 0.045],
  [10000000, 0.055],
  [20000000, 0.065],
  [null, 0.075],
];

/** Mirrors the closing_cost_config column defaults exactly. */
export const DEFAULT_RATES: ClosingCostRates = {
  regTransfer: 85,
  regMortgage: 85,
  teraview: 54.8,
  sheriff: 133.6,
  legalFees: 1200,
  legalTitleSubmission: 150,
  adminFee: 250,
  hstRate: 0.13,
  rebateOntarioMax: 4000,
  rebateTorontoMax: 4475,
  titlePremiumBase: 250,
  titlePremiumRate: 0.000785,
  titlePremiumMin: 300,
  lttTiers: DEFAULT_LTT_TIERS,
  mlttTiers: DEFAULT_MLTT_TIERS,
};

// ───────────────────────────── helpers ─────────────────────────────

/**
 * Round to cents, half away from zero.
 *
 * Every displayed figure goes through this, and totals are summed from the
 * ROUNDED lines — not rounded at the end. That is what makes the statement add
 * up on screen (HST 232.492 → 232.49, and 18,075.00 + … + 232.49 = 21,363.69
 * exactly). Summing unrounded and rounding last would leave the printed lines
 * one cent short of the printed total.
 *
 * The 1e-8 nudge is applied to the absolute value so a true half (12.345) goes
 * up rather than being decided by its binary representation, and so negative
 * amounts (rebates) round away from zero instead of JS's Math.round bias
 * toward +Infinity.
 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-8)) / 100;
}

/**
 * True when an optional override actually carries a figure.
 *
 * Presence, not truthiness: an explicit 0 is a legitimate override (an exempt
 * transfer, a waived premium) and must not fall back to the calculation.
 */
function isSupplied(v: unknown): boolean {
  return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
}

/** Coerce anything (form string, DB numeric, null) to a finite number. */
export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** True when `t` is a usable [[cap, rate], ...] bracket table. */
export function isTierArray(t: unknown): t is Tier[] {
  return (
    Array.isArray(t) &&
    t.length > 0 &&
    t.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        (row[0] === null || (typeof row[0] === "number" && Number.isFinite(row[0]))) &&
        typeof row[1] === "number" &&
        Number.isFinite(row[1]),
    )
  );
}

function coerceTiers(t: unknown, fallback: Tier[]): Tier[] {
  return isTierArray(t) ? (t as Tier[]) : fallback;
}

/**
 * Marginal tiered tax. Each rate applies only to the portion of `price` inside
 * its band; a null cap is treated as Infinity.
 */
function tieredTax(price: number, tiers: Tier[]): number {
  if (!(price > 0)) return 0;
  let tax = 0;
  let prev = 0;
  for (const [cap, rate] of tiers) {
    const c = cap === null ? Infinity : cap;
    if (price <= prev) break;
    tax += (Math.min(price, c) - prev) * rate;
    prev = c;
  }
  return tax;
}

/**
 * The legal fee split that `legal_fees` replaced, as it was configured before
 * the merge. Only ever used to reconstitute a row written under the old shape.
 */
const LEGACY_LEGAL_SPLIT = { transfer: 650, mortgage: 550 } as const;

/**
 * The one legal-fee figure, from a row that may predate the merge.
 *
 * `legal_fees` wins whenever it is present, so a settings edit takes effect as
 * soon as the backfill has run — even while the legacy pair is still sitting on
 * the same row, between the add-column and drop-column migrations.
 *
 * Only when it is absent is the pair summed: a frozen `rates_used` snapshot on
 * an already-issued estimate, or a config row read by a build that deployed
 * ahead of the migration. That sum reproduces what the old row charged WITH a
 * mortgage. It cannot reproduce what a cash purchase was charged under the old
 * rules, and does not need to — an issued estimate renders from its own frozen
 * `line_items`, never by recomputing.
 */
function legalFeesOf(row: Record<string, unknown>, d: ClosingCostRates): number {
  const merged = row.legal_fees;
  if (merged !== null && merged !== undefined && merged !== "") {
    return num(merged, d.legalFees);
  }
  const transfer = row.legal_transfer;
  const mortgage = row.legal_mortgage;
  const hasLegacy =
    (transfer !== null && transfer !== undefined) ||
    (mortgage !== null && mortgage !== undefined);
  if (!hasLegacy) return d.legalFees;
  return (
    num(transfer, LEGACY_LEGAL_SPLIT.transfer) + num(mortgage, LEGACY_LEGAL_SPLIT.mortgage)
  );
}

/** Map a `closing_cost_config` row (snake_case, numeric-as-string) to rates. */
export function ratesFromConfigRow(
  row: Record<string, unknown> | null | undefined,
): ClosingCostRates {
  if (!row) return DEFAULT_RATES;
  const d = DEFAULT_RATES;
  return {
    regTransfer: num(row.reg_transfer, d.regTransfer),
    regMortgage: num(row.reg_mortgage, d.regMortgage),
    teraview: num(row.teraview, d.teraview),
    sheriff: num(row.sheriff, d.sheriff),
    legalFees: legalFeesOf(row, d),
    legalTitleSubmission: num(row.legal_title_submission, d.legalTitleSubmission),
    adminFee: num(row.admin_fee, d.adminFee),
    hstRate: num(row.hst_rate, d.hstRate),
    rebateOntarioMax: num(row.rebate_ontario_max, d.rebateOntarioMax),
    rebateTorontoMax: num(row.rebate_toronto_max, d.rebateTorontoMax),
    titlePremiumBase: num(row.title_premium_base, d.titlePremiumBase),
    titlePremiumRate: num(row.title_premium_rate, d.titlePremiumRate),
    titlePremiumMin: num(row.title_premium_min, d.titlePremiumMin),
    lttTiers: coerceTiers(row.ltt_tiers, d.lttTiers),
    mlttTiers: coerceTiers(row.mltt_tiers, d.mlttTiers),
  };
}

/** Inverse of ratesFromConfigRow — for writing the frozen rates_used snapshot. */
export function ratesToSnapshot(r: ClosingCostRates): Record<string, unknown> {
  return {
    calc_version: CALC_VERSION,
    reg_transfer: r.regTransfer,
    reg_mortgage: r.regMortgage,
    teraview: r.teraview,
    sheriff: r.sheriff,
    legal_fees: r.legalFees,
    legal_title_submission: r.legalTitleSubmission,
    admin_fee: r.adminFee,
    hst_rate: r.hstRate,
    rebate_ontario_max: r.rebateOntarioMax,
    rebate_toronto_max: r.rebateTorontoMax,
    title_premium_base: r.titlePremiumBase,
    title_premium_rate: r.titlePremiumRate,
    title_premium_min: r.titlePremiumMin,
    ltt_tiers: r.lttTiers,
    mltt_tiers: r.mlttTiers,
  };
}

// ───────────────────────────── formulas ─────────────────────────────

/** Ontario provincial land transfer tax. */
export function provincialLTT(price: number, tiers: Tier[] = DEFAULT_LTT_TIERS): number {
  return tieredTax(price, tiers);
}

/**
 * Toronto municipal land transfer tax. At or below $2M this equals the
 * provincial LTT (identical bands); above it the luxury tiers diverge.
 */
export function torontoMLTT(price: number, tiers: Tier[] = DEFAULT_MLTT_TIERS): number {
  return tieredTax(price, tiers);
}

/**
 * FCT title-insurance premium approximation: a base plus a rate on price, with
 * a minimum premium floor (title insurers charge one regardless of price — it
 * only engages below roughly $63,700).
 *
 * A firm approximation, not FCT's official rate table; the exact quote governs
 * any figure that will be relied upon.
 */
export function titlePremiumEstimate(
  price: number,
  rates: ClosingCostRates = DEFAULT_RATES,
): number {
  if (!(price > 0)) return 0;
  return Math.max(
    rates.titlePremiumMin,
    rates.titlePremiumBase + price * rates.titlePremiumRate,
  );
}

/** "13%" / "12.5%" for the HST line label. */
export function formatRatePercent(rate: number): string {
  const pct = rate * 100;
  return `${Number.isInteger(pct) ? pct : Number(pct.toFixed(4))}%`;
}

// ─────────────────────────── the statement ───────────────────────────

/**
 * Build the full client-facing statement.
 *
 * Lines that don't apply are OMITTED from the groups entirely — no
 * "Registration of Mortgage" on a cash purchase, no municipal LTT outside
 * Toronto, no rebate lines unless first-time buyer — so the renderer (screen
 * and PDF) never needs conditional logic and a frozen snapshot renders
 * identically to a live computation.
 */
export function computeStatement(
  inputs: ClosingCostInputs,
  rates: ClosingCostRates = DEFAULT_RATES,
): Statement {
  const price = Math.max(0, num(inputs.price));
  const deposit = Math.max(0, num(inputs.deposit));
  const mortgage = Math.max(0, num(inputs.mortgage));
  const { isToronto, isFirstTimeBuyer } = inputs;
  const hasMortgage = mortgage > 0;

  // Provisional figures are badged HERE so the screen, the PDF and a frozen
  // snapshot all say the same thing. Each surface used to decide for itself,
  // which is how the PDF ended up badging one line where the screens badged
  // four.
  const estimateBadge = inputs.isFinalAccount ? undefined : "ESTIMATE";

  // ── Land transfer tax ──
  // A supplied dollar figure replaces the bracket calculation. An explicit 0 is
  // a real override (an exempt transfer), so presence is what counts, not truth.
  const provincial = isSupplied(inputs.provincialLttOverride)
    ? round2(num(inputs.provincialLttOverride))
    : round2(provincialLTT(price, rates.lttTiers));
  // A municipal override is ignored outside Toronto: the municipal line is not
  // printed there, so honouring one would add tax to the total with nothing on
  // the statement to account for it.
  const municipal = !isToronto
    ? 0
    : isSupplied(inputs.municipalLttOverride)
      ? round2(num(inputs.municipalLttOverride))
      : round2(torontoMLTT(price, rates.mlttTiers));
  // Each rebate reduces its own tax (not the price) and is capped. The Toronto
  // rebate applies only to a Toronto property.
  const ontRebate = isFirstTimeBuyer
    ? round2(Math.min(provincial, rates.rebateOntarioMax))
    : 0;
  const torRebate =
    isFirstTimeBuyer && isToronto
      ? round2(Math.min(municipal, rates.rebateTorontoMax))
      : 0;

  const lttLines: StatementLine[] = [
    {
      key: "ltt_provincial",
      label: "Ontario provincial land transfer tax",
      amount: provincial,
    },
  ];
  if (isFirstTimeBuyer) {
    lttLines.push({
      key: "rebate_ontario",
      label: "less: Ontario first-time buyer rebate",
      amount: -ontRebate,
    });
  }
  if (isToronto) {
    lttLines.push({
      key: "ltt_municipal",
      label: "Toronto municipal land transfer tax",
      amount: municipal,
    });
    if (isFirstTimeBuyer) {
      lttLines.push({
        key: "rebate_toronto",
        label: "less: Toronto first-time buyer rebate",
        amount: -torRebate,
      });
    }
  }

  // ── Title insurance ──
  const override = inputs.titlePremiumOverride;
  const hasOverride = isSupplied(override);
  const titlePremium = hasOverride
    ? round2(num(override))
    : round2(titlePremiumEstimate(price, rates));

  const titleLine: StatementLine = {
    key: "title_premium",
    label: "First Canadian Title — premium",
    amount: titlePremium,
  };
  // The badge is what tells the client this figure is not yet the real quote —
  // so it must disappear the moment a staff member pastes the actual one, and
  // on a final account where nothing is provisional.
  if (!hasOverride && estimateBadge) titleLine.badge = estimateBadge;

  // The firm's charge for preparing and submitting the title insurance
  // application. Shown under Title Insurance rather than inside the legal fee
  // so the client can see what the title work costs on its own. It is still a
  // supply BY THE FIRM, so it stays in the HST base below.
  const titleSubmission = round2(rates.legalTitleSubmission);
  const titleSubmissionLine: StatementLine = {
    key: "title_submission",
    label: "First Canadian Title Insurance — submission & review",
    amount: titleSubmission,
  };

  // ── Third-party disbursements ──
  const regTransfer = round2(rates.regTransfer);
  const regMortgage = hasMortgage ? round2(rates.regMortgage) : 0;
  const teraview = round2(rates.teraview);
  const sheriff = round2(rates.sheriff);

  const thirdPartyLines: StatementLine[] = [
    { key: "reg_transfer", label: "Registration of Transfer", amount: regTransfer },
  ];
  if (hasMortgage) {
    thirdPartyLines.push({
      key: "reg_mortgage",
      label: "Registration of Mortgage",
      amount: regMortgage,
    });
  }
  // Both are priced from a standard schedule, but the final charge depends on
  // how many searches and certificates the file actually needs — so both are
  // badged on a draft.
  thirdPartyLines.push(
    {
      key: "teraview",
      label: "Teraview — title searches & review",
      amount: teraview,
      ...(estimateBadge ? { badge: estimateBadge } : {}),
    },
    {
      key: "sheriff",
      label: "Sheriff's Certificates",
      sublabel:
        "searches confirming no judgments or liens are registered against the parties",
      amount: sheriff,
      ...(estimateBadge ? { badge: estimateBadge } : {}),
    },
  );

  // ── Legal & admin fees ──
  // One flat professional fee, charged whether or not there is a mortgage.
  // Title submission is billed separately, under Title Insurance above.
  //
  // No sublabel. It used to read "purchase & mortgage" / "purchase" — a scope
  // note from when the fee was two amounts that were added together. Now that it
  // is ONE flat fee that does not move with the mortgage, spelling out the scope
  // under the line invited exactly the question it used to answer ("so which
  // part is the mortgage?") about a figure that no longer has parts.
  const legalFees = round2(rates.legalFees);
  const adminFee = round2(rates.adminFee);

  const legalLines: StatementLine[] = [
    {
      key: "legal_fees",
      label: "Legal fees",
      amount: legalFees,
    },
    {
      key: "admin_fee",
      label: "Admin fee",
      amount: adminFee,
      sublabel: "software, storage, banking, courier & administrative charges",
    },
  ];

  // ── HST ──
  // Taxable fees/disbursements only. NOT land transfer tax, NOT the government
  // registration fees, NOT the title insurance premium. Computed from the
  // already-rounded line amounts so the arithmetic is reproducible from the
  // printed statement.
  //
  // The title-submission charge is in here even though it prints under Title
  // Insurance: what decides HST is who supplies the service, and that is the
  // firm. Moving it out of the legal-fees LINE did not move it out of the BASE.
  const taxableBase = round2(
    legalFees + titleSubmission + adminFee + teraview + sheriff,
  );
  const hstAmount = round2(rates.hstRate * taxableBase);

  const groups: StatementGroup[] = [
    { key: "ltt", title: "Land Transfer Tax", lines: lttLines },
    { key: "title", title: "Title Insurance", lines: [titleLine, titleSubmissionLine] },
    { key: "third_party", title: "Third-Party Disbursements", lines: thirdPartyLines },
    { key: "legal", title: "Legal & Admin Fees", lines: legalLines },
  ];

  // ── Property tax adjustment ──
  // A Statement of Adjustments item, not a fee: it reimburses the seller for
  // tax already paid past the closing date. It carries no HST and is NOT part
  // of "Total closing costs" — it is added to the balance on its own line, so
  // the printed total stays exactly "fees, taxes & disbursements".
  const propertyTax = round2(num(inputs.propertyTaxAdjustment));
  const propertyTaxLine: StatementLine | null =
    propertyTax === 0
      ? null
      : {
          key: "property_tax_adjustment",
          label: "Property tax & common expense adjustments",
          amount: propertyTax,
          sublabel:
            "confirmed once we receive the Statement of Adjustments from the seller's lawyer",
          ...(estimateBadge ? { badge: estimateBadge } : {}),
        };

  // ── Totals ──
  const lineSum = groups.reduce(
    (sum, g) => sum + g.lines.reduce((s, l) => s + l.amount, 0),
    0,
  );
  const total = round2(lineSum + hstAmount);
  const balanceDue = round2(price - deposit - mortgage + total + propertyTax);

  return {
    calcVersion: CALC_VERSION,
    groups,
    hst: {
      label: `HST @ ${formatRatePercent(rates.hstRate)} on taxable fees & disbursements`,
      amount: hstAmount,
    },
    total,
    propertyTax: propertyTaxLine,
    balance: {
      purchasePrice: round2(price),
      depositPaid: round2(deposit),
      mortgageAmount: round2(mortgage),
      closingCosts: total,
      propertyTaxAdjustment: propertyTax,
      balanceDue,
    },
    detail: {
      provincialLTT: provincial,
      municipalLTT: municipal,
      ontarioRebate: ontRebate,
      torontoRebate: torRebate,
      netLTT: round2(provincial + municipal - ontRebate - torRebate),
      titlePremium,
      titlePremiumIsEstimate: !hasOverride,
      legalFees,
      registrations: round2(regTransfer + regMortgage),
      taxableBase,
      propertyTaxAdjustment: propertyTax,
    },
  };
}

// ───────────────────── client-facing copy ─────────────────────
// Tooltips live here rather than inside the frozen line_items snapshot, so the
// wording can be improved without rewriting estimates already issued.

export const LINE_TOOLTIPS: Record<string, string> = {
  ltt_provincial:
    "Tax paid to the Province of Ontario when property changes hands. Calculated on the purchase price entered above.",
  rebate_ontario:
    "Ontario's first-time home buyer refund, applied against the provincial land transfer tax. Eligibility must be confirmed.",
  ltt_municipal:
    "An additional land transfer tax charged by the City of Toronto, on top of the provincial tax.",
  rebate_toronto:
    "Toronto's first-time home buyer rebate, applied against the municipal land transfer tax. Eligibility must be confirmed.",
  title_premium:
    "A one-time First Canadian Title insurance premium that protects your ownership (and your lender) against title defects, fraud, judgments, liens and survey issues. Estimated from the purchase price; replaced with the exact First Canadian Title quote once available.",
  title_submission:
    "Our charge for preparing and submitting the title insurance application to First Canadian Title, and reviewing the policy issued for your file.",
  reg_transfer:
    "The government fee to electronically register the transfer of title into your name.",
  reg_mortgage:
    "The government fee to electronically register your lender's mortgage on title.",
  teraview:
    "Title and off-title searches through Ontario's electronic land registry, plus our review of the results.",
  sheriff:
    "Execution (Sheriff's) searches confirming there are no outstanding judgments or liens against the buyers or sellers affecting the property.",
  legal_fees:
    "Our professional fee for the purchase: completing and registering the transfer into your name, and handling your lender's mortgage instructions.",
  admin_fee:
    "Office and administrative charges: legal software, secure file storage, banking, courier and postage.",
  property_tax_adjustment:
    "Your share of the property tax the seller has already paid for the part of the year you will own the home. Taken from the Statement of Adjustments, not from our fees.",
  hst: "Ontario HST, charged only on the taxable legal fees and disbursements. It does not apply to land transfer tax, government registration fees, or the title insurance premium.",
  total:
    "The estimated total of all taxes, disbursements and fees payable in connection with your purchase.",
  balance_due:
    "The purchase price, less the deposit you have already paid and the amount your lender is advancing, plus the closing costs above. This is roughly what you will need to bring.",
};

/** Must appear on screen AND in the PDF. */
export const DISCLAIMERS: string[] = [
  "This is an estimate for planning purposes only. Final figures will be set out in the Statement of Account before closing.",
  "It excludes Statement of Adjustments items — property tax, utility and condominium fee prorations, and interest — which are settled at closing and typically add a modest amount.",
  "The title insurance premium is an approximation and should be confirmed against the actual First Canadian Title quote before the figure is relied upon.",
  "Land transfer tax assumes a standard residential purchase. The first-time home buyer rebate is applied only when selected, and eligibility must be confirmed.",
  "E. & O.E.",
];
