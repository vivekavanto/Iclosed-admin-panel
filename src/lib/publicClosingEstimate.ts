// The PUBLIC closing-cost estimator: what an anonymous visitor is allowed to
// send, what they are allowed to see back, and how the server turns the one into
// the other.
//
// ── Why this is not the per-deal path ───────────────────────────────────────
// `closingEstimate.ts` parses a STAFF payload: firm choice, statement type,
// per-file rate overrides, file number, purchaser names. Every one of those is a
// decision the firm makes, and none may be made by a stranger with a URL — a
// visitor who could post `rate_overrides` could mint a statement on the firm's
// letterhead quoting a $1 legal fee.
//
// So the public payload is deliberately five numbers and two booleans. Everything
// else — which firm, which fee schedule, which disclaimers, the Statement of
// Adjustments planning figure — is resolved SERVER-SIDE from the same settings
// the staff calculator reads. The visitor chooses their own circumstances; the
// firm chooses its own prices.
//
// The page recomputes the identical statement in the browser on every keystroke
// via the same pure `computeStatement`, so the live preview and the PDF/email
// the server produces cannot disagree.

import {
  computeStatement,
  ratesFromConfigRow,
  DISCLAIMERS,
  type ClosingCostRates,
  type Statement,
} from "./closingCosts.ts";
import { readActiveConfig, readStatementType } from "./closingCostConfig";
import { isPrivateBlobUrl } from "./blobPrivacy";
import type { StatementTypeConfig } from "./closingCostSettings.ts";

/**
 * Ceiling for a publicly-posted amount.
 *
 * Far lower than the staff path's $1B: this endpoint is unauthenticated, and a
 * plausible residential ceiling keeps a nonsense figure from reaching the
 * bracket loop and the PDF renderer at all. A genuine purchase above this is a
 * file that belongs with a clerk, not with a public estimator.
 */
export const MAX_PUBLIC_AMOUNT = 100_000_000;

/** Everything the public form may decide. */
export interface PublicEstimateInput {
  purchasePrice: number;
  depositPaid: number;
  mortgageAmount: number;
  isToronto: boolean;
  isFirstTimeBuyer: boolean;
  /** Optional, for the email greeting and the PDF header. Never persisted. */
  clientName: string | null;
}

const MAX_NAME_LENGTH = 60;

/**
 * Characters a person's name may contain.
 *
 * Deliberately narrow, and enforced rather than escaped away. The name is echoed
 * into an email the firm sends — "Hi {name}," — to an address the same anonymous
 * caller supplied. `escapeHtml` already stops that becoming markup, but it does
 * nothing about PROSE: a 60-character "name" is room enough for a sentence and a
 * domain, which would arrive in a stranger's inbox under the firm's name.
 *
 * Restricting to letters, spaces and the punctuation that appears in real names
 * removes the digits, slashes and colons a URL needs, so the field can only ever
 * be what it claims to be.
 */
const NAME_SHAPE = /^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u;

/**
 * Validate an untrusted request body into `PublicEstimateInput`.
 *
 * Returns `{ error }` with a message safe to show a stranger — it says what they
 * typed wrong and nothing about the system.
 */
export function parsePublicEstimatePayload(
  body: Record<string, unknown>,
): { error: string } | { input: PublicEstimateInput } {
  const amounts: Array<[keyof PublicEstimateInput, string]> = [
    ["purchasePrice", "Purchase price"],
    ["depositPaid", "Deposit already paid"],
    ["mortgageAmount", "Mortgage amount"],
  ];

  // Accept both spellings so the browser can post the camelCase it already
  // holds while a hand-rolled caller can use the snake_case the rest of the API
  // speaks.
  const snake: Record<string, string> = {
    purchasePrice: "purchase_price",
    depositPaid: "deposit_paid",
    mortgageAmount: "mortgage_amount",
  };

  const parsed: Record<string, number> = {};
  for (const [key, label] of amounts) {
    const raw = body[key] ?? body[snake[key as string]];
    const value = raw === null || raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value)) return { error: `${label} must be a number.` };
    if (value < 0) return { error: `${label} cannot be negative.` };
    if (value > MAX_PUBLIC_AMOUNT) {
      return {
        error: `${label} is larger than this calculator handles — please contact us directly.`,
      };
    }
    parsed[key as string] = value;
  }

  if (!(parsed.purchasePrice > 0)) {
    return { error: "Enter a purchase price to calculate your closing costs." };
  }

  const rawName = body.clientName ?? body.client_name;
  const clientName = String(rawName ?? "").trim();
  if (clientName.length > MAX_NAME_LENGTH) {
    return { error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }
  if (clientName && !NAME_SHAPE.test(clientName)) {
    return { error: "Name can only contain letters, spaces, hyphens and apostrophes." };
  }

  return {
    input: {
      purchasePrice: parsed.purchasePrice,
      depositPaid: parsed.depositPaid,
      mortgageAmount: parsed.mortgageAmount,
      isToronto: body.isToronto === true || body.is_toronto === true,
      isFirstTimeBuyer:
        body.isFirstTimeBuyer === true || body.is_first_time_buyer === true,
      clientName: clientName || null,
    },
  };
}

export interface PublicEstimateResult {
  statement: Statement;
  /** The merged firm row — letterhead + rates. Server-side only; not returned raw. */
  config: Record<string, unknown>;
  statementType: StatementTypeConfig;
  rates: ClosingCostRates;
}

/**
 * Compute the statement a public visitor gets.
 *
 * Always the DRAFT flavour, never a final account: a final states charges
 * actually incurred on a real file, and nothing typed into an anonymous form is
 * that. This is also what keeps every provisional line carrying its ESTIMATE
 * badge on the page and in the PDF.
 */
export async function computePublicEstimate(
  input: PublicEstimateInput,
): Promise<PublicEstimateResult> {
  const [{ row: config }, statementType] = await Promise.all([
    readActiveConfig(),
    readStatementType("draft"),
  ]);

  const rates = ratesFromConfigRow(config);
  const statement = computeStatement(
    {
      price: input.purchasePrice,
      deposit: input.depositPaid,
      mortgage: input.mortgageAmount,
      isToronto: input.isToronto,
      isFirstTimeBuyer: input.isFirstTimeBuyer,
      propertyTaxAdjustment: publicPropertyTaxAdjustment(config),
      isFinalAccount: false,
    },
    rates,
  );

  return { statement, config, statementType, rates };
}

/**
 * The Statement of Adjustments figure a public estimate carries.
 *
 * A visitor cannot know their own — it comes from the seller's lawyer weeks
 * later — so the firm's planning default from Settings stands in, exactly as it
 * does when a clerk opens a new estimate. Leaving it out entirely would be the
 * worse error: the headline "funds you'll need" would read about a thousand
 * dollars light, and being under on that number is the direction that hurts.
 *
 * It is badged ESTIMATE on every surface and excluded from "total closing
 * costs", which stays exactly the firm's fees, taxes and disbursements.
 */
export function publicPropertyTaxAdjustment(
  config: Record<string, unknown>,
): number | null {
  const raw = config.property_tax_default;
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────── what the browser is handed ───────────────────────

/**
 * Rate columns the public page needs to reproduce the calculation locally.
 *
 * An explicit allowlist rather than the merged row minus a few keys: the row is
 * assembled from two tables that gain columns over time, and a subtractive
 * filter silently publishes whatever is added next. Everything here is already
 * printed on the statements the firm sends clients.
 *
 * The legacy `legal_transfer` / `legal_mortgage` pair rides along so a database
 * still sitting between the add-column and drop-column migrations computes the
 * same figure in the browser as it does on the server — `ratesFromConfigRow`
 * falls back to summing them when `legal_fees` is absent.
 */
const PUBLIC_RATE_COLUMNS = [
  "reg_transfer",
  "reg_mortgage",
  "teraview",
  "sheriff",
  "legal_fees",
  "legal_transfer",
  "legal_mortgage",
  "legal_title_submission",
  "admin_fee",
  "hst_rate",
  "rebate_ontario_max",
  "rebate_toronto_max",
  "title_premium_base",
  "title_premium_rate",
  "title_premium_min",
  "ltt_tiers",
  "mltt_tiers",
] as const;

/** Letterhead fields — the same ones already printed on every client PDF. */
const PUBLIC_LETTERHEAD_COLUMNS = [
  "firm_name",
  "firm_subtitle",
  "firm_address",
  "firm_phone",
  "firm_fax",
  "firm_hst_number",
  "brand_color",
] as const;

export interface PublicCalculatorConfig {
  rates: Record<string, unknown>;
  firm: Record<string, unknown>;
  /** Null when the firm has no logo, or has one the public cannot fetch. */
  logo_url: string | null;
  property_tax_default: number | null;
  statement_type: {
    label: string;
    disclaimer_intro: string;
    footer_note: string;
  };
  disclaimers: string[];
}

/**
 * The merged config row reduced to what a public page may see.
 *
 * A PRIVATE logo URL is dropped rather than passed through: serving it would
 * mean routing an anonymous visitor at `/api/admin/documents/download`, which is
 * behind the admin gate and would 401 — so the page falls back to the typeset
 * firm name, which is what the PDF does for an unreachable logo too.
 */
export function publicConfigPayload(
  config: Record<string, unknown>,
  statementType: StatementTypeConfig,
): PublicCalculatorConfig {
  const rates: Record<string, unknown> = {};
  for (const key of PUBLIC_RATE_COLUMNS) {
    if (config[key] !== null && config[key] !== undefined) rates[key] = config[key];
  }

  const firm: Record<string, unknown> = {};
  for (const key of PUBLIC_LETTERHEAD_COLUMNS) {
    if (config[key] !== null && config[key] !== undefined) firm[key] = config[key];
  }

  const rawLogo = typeof config.logo_url === "string" ? config.logo_url.trim() : "";
  const logo_url = rawLogo && !isPrivateBlobUrl(rawLogo) ? rawLogo : null;

  return {
    rates,
    firm,
    logo_url,
    property_tax_default: publicPropertyTaxAdjustment(config),
    statement_type: {
      label: statementType.label,
      disclaimer_intro: statementType.disclaimer_intro,
      footer_note: statementType.footer_note,
    },
    disclaimers: DISCLAIMERS,
  };
}
