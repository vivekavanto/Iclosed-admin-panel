// Per-deal closing-cost estimate: validation, server-side computation, and the
// frozen snapshot written to `deal_closing_estimates`.
//
// The client computes the same statement locally on every keystroke for a live
// preview, but the server ALWAYS recomputes here from the raw inputs before
// saving — a client-sent total is never trusted. Both sides call the same pure
// module (src/lib/closingCosts.ts), so the numbers agree by construction.

// Explicit `.ts` extensions: this module is reachable from the node --test
// suite, whose ESM loader will not resolve an extensionless specifier. Same
// reason closingCostConfig.ts writes them.
import {
  CALC_VERSION,
  computeStatement,
  num,
  ratesFromConfigRow,
  ratesToSnapshot,
  type ClosingCostInputs,
  type ClosingCostRates,
  type Statement,
} from "./closingCosts.ts";
import {
  isFirmKey,
  isStatementTypeKey,
  type FirmKey,
  type StatementTypeConfig,
  type StatementTypeKey,
} from "./closingCostSettings.ts";
import {
  buildConfigSnapshot,
  configVersionOf,
} from "./closingCostConfigSnapshot.ts";

/** The per-file fee/rate overrides staff may set in "Adjust fixed fees & rates". */
export const OVERRIDABLE_RATE_KEYS = [
  "reg_transfer",
  "reg_mortgage",
  "teraview",
  "sheriff",
  "legal_fees",
  "legal_title_submission",
  "admin_fee",
  "hst_rate",
  "rebate_ontario_max",
  "rebate_toronto_max",
] as const;

/**
 * No longer offered in the UI, but still accepted: a draft saved before the
 * legal fee merge stored this pair instead of `legal_fees`, and the issue route
 * replays a stored draft's overrides through `parseEstimatePayload`. Dropping
 * them here would silently return that file to the firm standard on issue.
 *
 * `effectiveRates` is what folds them back into one fee. Delete both once no
 * `rate_overrides` snapshot carries them.
 */
export const LEGACY_RATE_OVERRIDE_KEYS = ["legal_transfer", "legal_mortgage"] as const;

export type RateOverrides = Partial<
  Record<
    | (typeof OVERRIDABLE_RATE_KEYS)[number]
    | (typeof LEGACY_RATE_OVERRIDE_KEYS)[number],
    number
  >
>;

export interface EstimateInputPayload {
  purchase_price: number;
  deposit_paid: number;
  mortgage_amount: number;
  is_toronto: boolean;
  is_first_time_buyer: boolean;
  title_premium_override: number | null;
  /**
   * Per-file dollar overrides for the land transfer tax, replacing the bracket
   * calculation. Null = use the brackets.
   */
  provincial_ltt_override: number | null;
  municipal_ltt_override: number | null;
  /** A Statement of Adjustments figure; may be negative. Null = none entered. */
  property_tax_adjustment: number | null;
  file_no_display: string | null;
  /** Printed on the statement header. */
  purchasers: string | null;
  property_address: string | null;
  /** ISO date (YYYY-MM-DD) or null. */
  closing_date: string | null;
  /** Which firm's letterhead and fee schedule this estimate uses. */
  firm_key: FirmKey | null;
  /** The client-facing document flavour — NOT the workflow status. */
  statement_type: StatementTypeKey | null;
  rate_overrides: RateOverrides;
}

const MAX_AMOUNT = 1_000_000_000; // $1B — well past any residential purchase

/** Long enough for "Firstname Lastname and Firstname Lastname" plus a third. */
const MAX_NAME_LENGTH = 200;
const MAX_ADDRESS_LENGTH = 300;

/** Bounds for a per-file override, mirroring the settings route's ceilings. */
const OVERRIDE_BOUNDS: Record<string, { min: number; max: number }> = {
  reg_transfer: { min: 0, max: 100_000 },
  reg_mortgage: { min: 0, max: 100_000 },
  teraview: { min: 0, max: 100_000 },
  sheriff: { min: 0, max: 100_000 },
  legal_fees: { min: 0, max: 1_000_000 },
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

  // Land transfer tax: blank means "use the brackets"; a value — including an
  // explicit 0, for an exempt transfer — replaces them.
  const lttOverrides: Record<"provincial_ltt_override" | "municipal_ltt_override", number | null> =
    { provincial_ltt_override: null, municipal_ltt_override: null };
  for (const [key, label] of [
    ["provincial_ltt_override", "Ontario provincial land transfer tax"],
    ["municipal_ltt_override", "Toronto municipal land transfer tax"],
  ] as Array<[keyof typeof lttOverrides, string]>) {
    const raw = body[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > MAX_AMOUNT) {
      return { error: `${label} must be a positive number, or left blank` };
    }
    lttOverrides[key] = value;
  }

  // Property tax adjustment: blank means none. A NEGATIVE value is legitimate —
  // a seller in arrears credits the buyer — so this is not bounded below at 0.
  const rawPropertyTax = body.property_tax_adjustment;
  let propertyTax: number | null = null;
  if (rawPropertyTax !== null && rawPropertyTax !== undefined && rawPropertyTax !== "") {
    const value = Number(rawPropertyTax);
    if (!Number.isFinite(value) || Math.abs(value) > MAX_AMOUNT) {
      return { error: "Property tax adjustment must be a number, or left blank" };
    }
    propertyTax = value;
  }

  const fileNo = String(body.file_no_display ?? "").trim();
  if (fileNo.length > 60) {
    return { error: "File No. must be 60 characters or fewer" };
  }

  const purchasers = String(body.purchasers ?? "").trim();
  if (purchasers.length > MAX_NAME_LENGTH) {
    return { error: `Purchaser(s) must be ${MAX_NAME_LENGTH} characters or fewer` };
  }

  const propertyAddress = String(body.property_address ?? "").trim();
  if (propertyAddress.length > MAX_ADDRESS_LENGTH) {
    return {
      error: `Property address must be ${MAX_ADDRESS_LENGTH} characters or fewer`,
    };
  }

  // Stored as a plain date string — the statement prints it, never arithmetics
  // with it, and a timestamptz would drift across timezones on the boundary.
  const closingDateRaw = String(body.closing_date ?? "").trim();
  let closingDate: string | null = null;
  if (closingDateRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(closingDateRaw)) {
      return { error: "Closing date must be a YYYY-MM-DD date" };
    }
    closingDate = closingDateRaw;
  }

  // Absent means "use the configured default" — resolved server-side, not here,
  // so this module stays free of database access.
  const rawFirm = body.firm_key;
  if (rawFirm !== null && rawFirm !== undefined && rawFirm !== "" && !isFirmKey(rawFirm)) {
    return { error: "Unknown firm" };
  }
  const rawType = body.statement_type;
  if (
    rawType !== null &&
    rawType !== undefined &&
    rawType !== "" &&
    !isStatementTypeKey(rawType)
  ) {
    return { error: "Unknown statement type" };
  }

  // Per-file fee overrides. Unknown keys are dropped silently, matching the
  // whitelist behaviour of the deals PATCH route.
  const overrides: RateOverrides = {};
  const rawOverrides = body.rate_overrides;
  if (rawOverrides && typeof rawOverrides === "object") {
    for (const key of [...OVERRIDABLE_RATE_KEYS, ...LEGACY_RATE_OVERRIDE_KEYS]) {
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
      provincial_ltt_override: lttOverrides.provincial_ltt_override,
      municipal_ltt_override: lttOverrides.municipal_ltt_override,
      property_tax_adjustment: propertyTax,
      file_no_display: fileNo || null,
      purchasers: purchasers || null,
      property_address: propertyAddress || null,
      closing_date: closingDate,
      firm_key: isFirmKey(rawFirm) ? rawFirm : null,
      statement_type: isStatementTypeKey(rawType) ? rawType : null,
      rate_overrides: overrides,
    },
  };
}

/**
 * Why this file may not go out as a FINAL account yet, or null when it may.
 *
 * A draft carries the firm's planning figure for the Statement of Adjustments —
 * `property_tax_default`, $1,000 out of the box — so that an early estimate
 * lands in roughly the right place. On a final account that same figure is a
 * placeholder masquerading as a settled number, which is the one thing a
 * statement headed "Statement of Account" must never contain.
 *
 * So a final requires the figure to have been ENTERED. Null is the only thing
 * rejected: a genuine 0 (nothing owing either way) and a negative (the seller is
 * in arrears and credits the buyer) are both real answers.
 *
 * Lives here, next to the payload parser, because BOTH the issue route and the
 * email route have to apply it — issuing is not the only way a statement
 * reaches a client.
 */
export function finalStatementBlocker(
  statementType: string | null | undefined,
  propertyTaxAdjustment: unknown,
): string | null {
  if (statementType !== "final") return null;
  const raw = propertyTaxAdjustment;
  const missing =
    raw === null ||
    raw === undefined ||
    raw === "" ||
    !Number.isFinite(Number(raw));
  if (!missing) return null;
  return "A final account needs the property tax & common expense adjustment from the Statement of Adjustments. Enter it before issuing or sending.";
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
  const merged: Record<string, unknown> = { ...configRow, ...overrides };

  // A draft saved before the legal-fee merge stored `legal_transfer` /
  // `legal_mortgage` in `rate_overrides`. Layering those onto a migrated config
  // row would silently lose the deviation: `ratesFromConfigRow` prefers the
  // row's own `legal_fees` and the legacy keys would sit there doing nothing.
  //
  // Dropping `legal_fees` hands the row to that function's documented legacy
  // path, which sums the pair — taking each half from the override where the
  // clerk set one and from the config row (or the old defaults) where they
  // didn't. Delete once no `rate_overrides` snapshot carries the old keys.
  const bag = overrides as Record<string, unknown>;
  const hasLegacyOverride =
    bag.legal_transfer !== undefined || bag.legal_mortgage !== undefined;
  if (hasLegacyOverride && bag.legal_fees === undefined) {
    delete merged.legal_fees;
  }

  return ratesFromConfigRow(merged);
}

/**
 * Columns to write for a save — inputs plus the frozen snapshots.
 *
 * THREE things are frozen, and all three are needed for an estimate to still
 * mean what it meant when it was sent:
 *
 *   line_items      the figures
 *   rates_used      the fee schedule that produced them
 *   config_snapshot the letterhead and wording they were printed under
 *
 * `statementType` is what supplies the third. It is optional only so a caller
 * that has not resolved one yet still writes the first two rather than
 * throwing; omitting it snapshots the draft wording, which is the flavour a
 * statement carries until staff choose otherwise.
 */
export function buildEstimateRow(
  payload: EstimateInputPayload,
  configRow: Record<string, unknown>,
  statementType?: StatementTypeConfig | null,
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
    provincialLttOverride: payload.provincial_ltt_override,
    municipalLttOverride: payload.municipal_ltt_override,
    propertyTaxAdjustment: payload.property_tax_adjustment,
    // A final account states charges actually incurred, so nothing on it is
    // badged as an estimate.
    isFinalAccount: payload.statement_type === "final",
  };

  const statement = computeStatement(inputs, rates);
  const configSnapshot = buildConfigSnapshot(configRow, statementType);

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
      provincial_ltt_override: payload.provincial_ltt_override,
      municipal_ltt_override: payload.municipal_ltt_override,
      property_tax_adjustment: payload.property_tax_adjustment,
      file_no_display: payload.file_no_display,
      purchasers: payload.purchasers,
      property_address: payload.property_address,
      closing_date: payload.closing_date,
      firm_key: payload.firm_key,
      statement_type: payload.statement_type,
      // Frozen snapshots. `rate_overrides` is kept alongside the effective rates
      // so the settings page's values and the per-file deviations stay
      // distinguishable when re-opening an estimate.
      rates_used: {
        ...ratesToSnapshot(rates),
        rate_overrides: payload.rate_overrides,
      },
      // The letterhead and wording this statement was printed under. Without it
      // a later settings edit would rewrite a document already sent — see
      // migrations/2026-08-08-closing-estimate-config-snapshot.sql.
      config_snapshot: configSnapshot,
      config_version: configVersionOf(rates, configSnapshot),
      line_items: statementToSnapshot(statement),
      total_closing_costs: statement.total,
      balance_due: statement.balance.balanceDue,
    },
  };
}

// ───────────────── deploy-order safety for the snapshot columns ─────────────
//
// `config_snapshot` / `config_version` arrive in a MANUALLY applied migration.
// Naming a column PostgREST has not seen yet is a hard error, so a build that
// reached production ahead of the SQL would fail every save on every file — not
// degrade, fail. The route file already keeps its SELECT as `*` for exactly
// this reason; this is the same care applied to the writes.

/** Added by migrations/2026-08-08-closing-estimate-config-snapshot.sql. */
const CONFIG_SNAPSHOT_COLUMNS = ["config_snapshot", "config_version"] as const;

/** PostgREST / Postgres codes for "that column does not exist (yet)". */
const MISSING_COLUMN_CODES = new Set(["PGRST204", "42703"]);

/** The same row without the columns the migration adds. */
function withoutConfigSnapshot(
  columns: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...columns };
  for (const key of CONFIG_SNAPSHOT_COLUMNS) delete rest[key];
  return rest;
}

/**
 * Run a write, and retry once without the snapshot columns if the database has
 * not been migrated yet.
 *
 * The estimate still saves; it simply saves without the freeze, which is
 * exactly the behaviour of every row written before this feature existed. Once
 * the SQL is run the retry stops being reached.
 *
 * Generic over the callback's WHOLE result rather than over its `data`, so the
 * supabase response type passes through untouched — a caller that returns on
 * `error` keeps getting `data` narrowed exactly as it would from a bare call.
 */
export async function writeEstimateRow<R>(
  columns: Record<string, unknown>,
  run: (columns: Record<string, unknown>) => PromiseLike<R>,
): Promise<R> {
  const first = await run(columns);
  const error = (first as { error?: { code?: string | null } | null } | null)?.error;
  if (!error || !MISSING_COLUMN_CODES.has(String(error.code ?? ""))) {
    return first;
  }
  return run(withoutConfigSnapshot(columns));
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
    property_tax: s.propertyTax
      ? {
          key: s.propertyTax.key,
          label: s.propertyTax.label,
          amount: s.propertyTax.amount,
          ...(s.propertyTax.sublabel ? { sublabel: s.propertyTax.sublabel } : {}),
        }
      : null,
    balance: {
      purchase_price: s.balance.purchasePrice,
      deposit_paid: s.balance.depositPaid,
      mortgage_amount: s.balance.mortgageAmount,
      closing_costs: s.balance.closingCosts,
      property_tax_adjustment: s.balance.propertyTaxAdjustment,
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
      property_tax_adjustment: s.detail.propertyTaxAdjustment,
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
    // Absent in a CALC_VERSION 1 snapshot, which had no adjustment at all.
    propertyTax: s.property_tax
      ? (() => {
          const p = bag(s.property_tax);
          return {
            key: String(p.key ?? "property_tax_adjustment"),
            label: String(p.label ?? "Property tax adjustment"),
            amount: num(p.amount),
            ...(p.sublabel ? { sublabel: String(p.sublabel) } : {}),
          };
        })()
      : null,
    balance: {
      purchasePrice: num(balance.purchase_price),
      depositPaid: num(balance.deposit_paid),
      mortgageAmount: num(balance.mortgage_amount),
      closingCosts: num(balance.closing_costs, num(s.total)),
      propertyTaxAdjustment: num(balance.property_tax_adjustment),
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
      // Absent in a CALC_VERSION 1 snapshot, which simply had no adjustment.
      propertyTaxAdjustment: num(detail.property_tax_adjustment),
    },
  };
}
