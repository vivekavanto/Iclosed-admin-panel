// Allow-lists and bounds for the three closing-cost settings PUT routes.
//
// Pure — no supabase, no Next — so the rules are testable and so all three
// routes share one description of what is editable. Anything not named here is
// silently ignored rather than written, which is the same posture the original
// single-config route took.

import {
  FIRM_KEYS,
  STATEMENT_TYPE_KEYS,
  hexColorError,
  tierError,
} from "./closingCostSettings.ts";

export interface NumericSpec {
  min: number;
  max: number;
}

/**
 * Statutory & third-party — one source of truth for every firm.
 * Bounds carried over verbatim from the original NUMERIC_COLUMNS.
 */
export const SHARED_NUMERIC: Record<string, NumericSpec> = {
  reg_transfer: { min: 0, max: 100_000 },
  reg_mortgage: { min: 0, max: 100_000 },
  property_tax_default: { min: 0, max: 1_000_000 },
  // A rate, not a percentage — 0.13 means 13%.
  hst_rate: { min: 0, max: 1 },
  rebate_ontario_max: { min: 0, max: 1_000_000 },
  rebate_toronto_max: { min: 0, max: 1_000_000 },
  title_premium_base: { min: 0, max: 1_000_000 },
  title_premium_rate: { min: 0, max: 1 },
  title_premium_min: { min: 0, max: 1_000_000 },
};

/** The firm's own charges — every one of them HST-taxable. */
export const FIRM_NUMERIC: Record<string, NumericSpec> = {
  legal_fees: { min: 0, max: 1_000_000 },
  legal_title_submission: { min: 0, max: 1_000_000 },
  admin_fee: { min: 0, max: 1_000_000 },
  teraview: { min: 0, max: 100_000 },
  sheriff: { min: 0, max: 100_000 },
};

export interface TextSpec {
  max: number;
  /** Reject an empty value rather than storing a blank. */
  required?: boolean;
}

export const FIRM_TEXT: Record<string, TextSpec> = {
  label: { max: 300, required: true },
  firm_name: { max: 300, required: true },
  firm_subtitle: { max: 300, required: true },
  firm_address: { max: 300, required: true },
  firm_phone: { max: 300, required: true },
  firm_fax: { max: 300, required: true },
  firm_hst_number: { max: 300, required: true },
  // Rendered as a small chip beside the "Legal & Admin Fees" heading.
  firm_badge: { max: 40, required: true },
};

/**
 * Caps here are not cosmetic: closingCostPdf.ts lays the title and disclaimer
 * block out from a running `y` with no page-break logic, so unbounded text runs
 * off the bottom of the page.
 */
export const STATEMENT_TYPE_TEXT: Record<string, TextSpec> = {
  label: { max: 60, required: true },
  title: { max: 120, required: true },
  screen_heading: { max: 120, required: true },
  disclaimer_intro: { max: 400, required: true },
  footer_note: { max: 600 },
  watermark_text: { max: 20, required: true },
};

export const TIER_COLUMNS = ["ltt_tiers", "mltt_tiers"] as const;

export interface CollectResult {
  error?: string;
  updates: Record<string, unknown>;
}

function collectNumeric(
  body: Record<string, unknown>,
  specs: Record<string, NumericSpec>,
  updates: Record<string, unknown>,
): string | null {
  for (const [key, bounds] of Object.entries(specs)) {
    if (!(key in body)) continue;
    const raw = body[key];
    const value = typeof raw === "number" ? raw : Number(raw);
    if (raw === null || raw === "" || !Number.isFinite(value)) {
      return `${key} must be a number`;
    }
    if (value < bounds.min || value > bounds.max) {
      return `${key} must be between ${bounds.min} and ${bounds.max}`;
    }
    updates[key] = value;
  }
  return null;
}

function collectText(
  body: Record<string, unknown>,
  specs: Record<string, TextSpec>,
  updates: Record<string, unknown>,
): string | null {
  for (const [key, spec] of Object.entries(specs)) {
    if (!(key in body)) continue;
    const value = String(body[key] ?? "").trim();
    if (!value && spec.required) return `${key} cannot be empty`;
    if (value.length > spec.max) {
      return `${key} must be ${spec.max} characters or fewer`;
    }
    updates[key] = value;
  }
  return null;
}

function collectTiers(
  body: Record<string, unknown>,
  updates: Record<string, unknown>,
): string | null {
  for (const key of TIER_COLUMNS) {
    if (!(key in body)) continue;
    const label =
      key === "ltt_tiers" ? "Ontario LTT brackets" : "Toronto MLTT brackets";
    const err = tierError(label, body[key]);
    if (err) return err;
    updates[key] = body[key];
  }
  return null;
}

/** Body → the columns a `closing_cost_shared_rates` update may write. */
export function collectSharedUpdates(body: Record<string, unknown>): CollectResult {
  const updates: Record<string, unknown> = {};

  const numericErr = collectNumeric(body, SHARED_NUMERIC, updates);
  if (numericErr) return { error: numericErr, updates: {} };

  const tierErr = collectTiers(body, updates);
  if (tierErr) return { error: tierErr, updates: {} };

  if ("default_firm_key" in body) {
    const value = String(body.default_firm_key ?? "");
    if (!(FIRM_KEYS as readonly string[]).includes(value)) {
      return { error: "default_firm_key must be a known firm", updates: {} };
    }
    updates.default_firm_key = value;
  }

  if ("default_statement_type" in body) {
    const value = String(body.default_statement_type ?? "");
    if (!(STATEMENT_TYPE_KEYS as readonly string[]).includes(value)) {
      return {
        error: "default_statement_type must be 'draft' or 'final'",
        updates: {},
      };
    }
    updates.default_statement_type = value;
  }

  return { updates };
}

/** Body → the columns one firm's `closing_cost_config` row may write. */
export function collectFirmUpdates(body: Record<string, unknown>): CollectResult {
  const updates: Record<string, unknown> = {};

  const numericErr = collectNumeric(body, FIRM_NUMERIC, updates);
  if (numericErr) return { error: numericErr, updates: {} };

  const textErr = collectText(body, FIRM_TEXT, updates);
  if (textErr) return { error: textErr, updates: {} };

  if ("brand_color" in body) {
    const err = hexColorError("brand_color", body.brand_color);
    if (err) return { error: err, updates: {} };
    updates.brand_color = String(body.brand_color).trim();
  }

  if ("is_active" in body) {
    if (typeof body.is_active !== "boolean") {
      return { error: "is_active must be true or false", updates: {} };
    }
    updates.is_active = body.is_active;
  }

  return { updates };
}

/** Body → the columns one `closing_cost_statement_types` row may write. */
export function collectStatementTypeUpdates(
  body: Record<string, unknown>,
): CollectResult {
  const updates: Record<string, unknown> = {};

  const textErr = collectText(body, STATEMENT_TYPE_TEXT, updates);
  if (textErr) return { error: textErr, updates: {} };

  if ("show_watermark" in body) {
    if (typeof body.show_watermark !== "boolean") {
      return { error: "show_watermark must be true or false", updates: {} };
    }
    updates.show_watermark = body.show_watermark;
  }

  return { updates };
}
