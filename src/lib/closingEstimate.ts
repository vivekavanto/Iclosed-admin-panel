// Per-deal closing-cost estimate: validation, server-side computation, and the
// frozen snapshot written to `deal_closing_estimates`.
//
// The client computes the same statement locally on every keystroke for a live
// preview, but the server ALWAYS recomputes here from the raw inputs before
// saving — a client-sent total is never trusted. Both sides call the same pure
// module (src/lib/closingCosts.ts), so the numbers agree by construction.

import {
  CALC_VERSION,
  computeStatement,
  num,
  ratesFromConfigRow,
  ratesToSnapshot,
  type ClosingCostInputs,
  type ClosingCostRates,
  type Statement,
} from "./closingCosts";

/** The per-file fee/rate overrides staff may set in "Adjust fixed fees & rates". */
export const OVERRIDABLE_RATE_KEYS = [
  "reg_transfer",
  "reg_mortgage",
  "teraview",
  "sheriff",
  "legal_transfer",
  "legal_mortgage",
  "legal_title_submission",
  "admin_fee",
  "hst_rate",
  "rebate_ontario_max",
  "rebate_toronto_max",
] as const;

export type RateOverrides = Partial<Record<(typeof OVERRIDABLE_RATE_KEYS)[number], number>>;

export interface EstimateInputPayload {
  purchase_price: number;
  deposit_paid: number;
  mortgage_amount: number;
  is_toronto: boolean;
  is_first_time_buyer: boolean;
  title_premium_override: number | null;
  file_no_display: string | null;
  rate_overrides: RateOverrides;
}

const MAX_AMOUNT = 1_000_000_000; // $1B — well past any residential purchase

/** Bounds for a per-file override, mirroring the settings route's ceilings. */
const OVERRIDE_BOUNDS: Record<string, { min: number; max: number }> = {
  reg_transfer: { min: 0, max: 100_000 },
  reg_mortgage: { min: 0, max: 100_000 },
  teraview: { min: 0, max: 100_000 },
  sheriff: { min: 0, max: 100_000 },
  legal_transfer: { min: 0, max: 1_000_000 },
  legal_mortgage: { min: 0, max: 1_000_000 },
  legal_title_submission: { min: 0, max: 1_000_000 },
  admin_fee: { min: 0, max: 1_000_000 },
  hst_rate: { min: 0, max: 1 },
  rebate_ontario_max: { min: 0, max: 1_000_000 },
  rebate_toronto_max: { min: 0, max: 1_000_000 },
};

/**
 * Validate and normalise a request body into estimate inputs.
 *
 * Returns `{ error }` with a client-safe message, or `{ payload }`.
 */
export function parseEstimatePayload(
  body: Record<string, unknown>,
): { error: string } | { payload: EstimateInputPayload } {
  const amounts: Array<["purchase_price" | "deposit_paid" | "mortgage_amount", string]> = [
    ["purchase_price", "Purchase price"],
    ["deposit_paid", "Deposit paid"],
    ["mortgage_amount", "Mortgage amount"],
  ];

  const parsed: Record<string, number> = {};
  for (const [key, label] of amounts) {
    const raw = body[key];
    const value = raw === null || raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value)) {
      return { error: `${label} must be a number` };
    }
    if (value < 0) return { error: `${label} cannot be negative` };
    if (value > MAX_AMOUNT) return { error: `${label} is unrealistically large` };
    parsed[key] = value;
  }

  // Title premium: absent/blank means "use the automatic estimate"; a value —
  // including an explicit 0 — is a real override.
  const rawOverride = body.title_premium_override;
  let titleOverride: number | null = null;
  if (rawOverride !== null && rawOverride !== undefined && rawOverride !== "") {
    const value = Number(rawOverride);
    if (!Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) {
      return { error: "Title insurance premium must be a positive number, or left blank" };
    }
    titleOverride = value;
  }

  const fileNo = String(body.file_no_display ?? "").trim();
  if (fileNo.length > 60) {
    return { error: "File No. must be 60 characters or fewer" };
  }

  // Per-file fee overrides. Unknown keys are dropped silently, matching the
  // whitelist behaviour of the deals PATCH route.
  const overrides: RateOverrides = {};
  const rawOverrides = body.rate_overrides;
  if (rawOverrides && typeof rawOverrides === "object") {
    for (const key of OVERRIDABLE_RATE_KEYS) {
      const raw = (rawOverrides as Record<string, unknown>)[key];
      if (raw === null || raw === undefined || raw === "") continue;
      const value = Number(raw);
      const bounds = OVERRIDE_BOUNDS[key];
      if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) {
        return { error: `${key} must be between ${bounds.min} and ${bounds.max}` };
      }
      overrides[key] = value;
    }
  }

  return {
    payload: {
      purchase_price: parsed.purchase_price,
      deposit_paid: parsed.deposit_paid,
      mortgage_amount: parsed.mortgage_amount,
      is_toronto: body.is_toronto === true,
      is_first_time_buyer: body.is_first_time_buyer === true,
      title_premium_override: titleOverride,
      file_no_display: fileNo || null,
      rate_overrides: overrides,
    },
  };
}

/**
 * The EFFECTIVE rates for a file: the firm config with any per-file overrides
 * layered on top. This is what gets frozen into `rates_used`, so a historic
 * estimate can always be explained even after the firm's standard fees move.
 */
export function effectiveRates(
  configRow: Record<string, unknown>,
  overrides: RateOverrides,
): ClosingCostRates {
  return ratesFromConfigRow({ ...configRow, ...overrides });
}

/** Columns to write for a save — inputs plus the frozen snapshots. */
export function buildEstimateRow(
  payload: EstimateInputPayload,
  configRow: Record<string, unknown>,
): {
  statement: Statement;
  rates: ClosingCostRates;
  columns: Record<string, unknown>;
} {
  const rates = effectiveRates(configRow, payload.rate_overrides);

  const inputs: ClosingCostInputs = {
    price: payload.purchase_price,
    deposit: payload.deposit_paid,
    mortgage: payload.mortgage_amount,
    isToronto: payload.is_toronto,
    isFirstTimeBuyer: payload.is_first_time_buyer,
    titlePremiumOverride: payload.title_premium_override,
  };

  const statement = computeStatement(inputs, rates);

  return {
    statement,
    rates,
    columns: {
      purchase_price: payload.purchase_price,
      deposit_paid: payload.deposit_paid,
      mortgage_amount: payload.mortgage_amount,
      is_toronto: payload.is_toronto,
      is_first_time_buyer: payload.is_first_time_buyer,
      title_premium_override: payload.title_premium_override,
      file_no_display: payload.file_no_display,
      // Frozen snapshots. `rate_overrides` is kept alongside the effective rates
      // so the settings page's values and the per-file deviations stay
      // distinguishable when re-opening an estimate.
      rates_used: {
        ...ratesToSnapshot(rates),
        rate_overrides: payload.rate_overrides,
      },
      line_items: statementToSnapshot(statement),
      total_closing_costs: statement.total,
      balance_due: statement.balance.balanceDue,
    },
  };
}

/** Serialise a Statement into the `line_items` jsonb shape. */
export function statementToSnapshot(s: Statement): Record<string, unknown> {
  return {
    calc_version: s.calcVersion,
    groups: s.groups.map((g) => ({
      key: g.key,
      title: g.title,
      lines: g.lines.map((l) => ({
        key: l.key,
        label: l.label,
        amount: l.amount,
        ...(l.sublabel ? { sublabel: l.sublabel } : {}),
        ...(l.badge ? { badge: l.badge } : {}),
      })),
    })),
    hst: { label: s.hst.label, amount: s.hst.amount },
    total: s.total,
    balance: {
      purchase_price: s.balance.purchasePrice,
      deposit_paid: s.balance.depositPaid,
      mortgage_amount: s.balance.mortgageAmount,
      closing_costs: s.balance.closingCosts,
      balance_due: s.balance.balanceDue,
    },
    detail: {
      provincial_ltt: s.detail.provincialLTT,
      municipal_ltt: s.detail.municipalLTT,
      ontario_rebate: s.detail.ontarioRebate,
      toronto_rebate: s.detail.torontoRebate,
      net_ltt: s.detail.netLTT,
      title_premium: s.detail.titlePremium,
      title_premium_is_estimate: s.detail.titlePremiumIsEstimate,
      legal_fees: s.detail.legalFees,
      registrations: s.detail.registrations,
      taxable_base: s.detail.taxableBase,
    },
  };
}

/**
 * Read a frozen `line_items` snapshot back into a Statement, so the same
 * renderer draws a saved estimate and a live computation.
 *
 * Tolerant of a snapshot written by an older CALC_VERSION: anything missing
 * falls back rather than throwing, because an issued estimate must always stay
 * viewable.
 */
/** Narrow an unknown jsonb value to a readable bag of properties. */
type Bag = Record<string, unknown>;
function bag(value: unknown): Bag {
  return value && typeof value === "object" ? (value as Bag) : {};
}

export function snapshotToStatement(snapshot: unknown): Statement | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const s = bag(snapshot);
  if (!Array.isArray(s.groups)) return null;

  const balance = bag(s.balance);
  const detail = bag(s.detail);
  const hst = bag(s.hst);

  return {
    calcVersion: num(s.calc_version, CALC_VERSION),
    groups: (s.groups as unknown[]).map((rawGroup) => {
      const g = bag(rawGroup);
      return {
        key: String(g.key ?? ""),
        title: String(g.title ?? ""),
        lines: Array.isArray(g.lines)
          ? (g.lines as unknown[]).map((rawLine) => {
              const l = bag(rawLine);
              return {
                key: String(l.key ?? ""),
                label: String(l.label ?? ""),
                amount: num(l.amount),
                ...(l.sublabel ? { sublabel: String(l.sublabel) } : {}),
                ...(l.badge ? { badge: String(l.badge) } : {}),
              };
            })
          : [],
      };
    }),
    hst: {
      label: String(hst.label ?? "HST"),
      amount: num(hst.amount),
    },
    total: num(s.total),
    balance: {
      purchasePrice: num(balance.purchase_price),
      depositPaid: num(balance.deposit_paid),
      mortgageAmount: num(balance.mortgage_amount),
      closingCosts: num(balance.closing_costs, num(s.total)),
      balanceDue: num(balance.balance_due),
    },
    detail: {
      provincialLTT: num(detail.provincial_ltt),
      municipalLTT: num(detail.municipal_ltt),
      ontarioRebate: num(detail.ontario_rebate),
      torontoRebate: num(detail.toronto_rebate),
      netLTT: num(detail.net_ltt),
      titlePremium: num(detail.title_premium),
      titlePremiumIsEstimate: detail.title_premium_is_estimate !== false,
      legalFees: num(detail.legal_fees),
      registrations: num(detail.registrations),
      taxableBase: num(detail.taxable_base),
    },
  };
}
