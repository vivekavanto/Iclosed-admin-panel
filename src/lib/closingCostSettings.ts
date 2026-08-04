// Firm profiles and statement types for the closing-cost calculator — the pure
// half, with NO supabase import, so it can be unit-tested under `node --test`
// without any environment. The DB readers live in `closingCostConfig.ts`.
//
// ── The split rule ──────────────────────────────────────────────────────────
// A closing-cost statement mixes two kinds of money, and which is which is not
// a matter of taste — `computeStatement` already encodes it:
//
//     taxableBase = legalFees + adminFee + teraview + sheriff
//
// HST is charged on exactly those four because they are supplies made BY THE
// FIRM. Land transfer tax, the FCT premium and the e-registration tariff are
// pass-throughs the firm does not supply, so they carry no HST. Hence:
//
//     charged HST  → a firm charge     → per-firm   (closing_cost_config)
//     no HST       → statutory / 3rd-party → shared (closing_cost_shared_rates)
//
// ── Why the merge exists ────────────────────────────────────────────────────
// `closingCosts.ts` is a TWIN FILE of the customer portal's copy and must not
// change. It reads ONE flat snake_case row via `ratesFromConfigRow`. So the
// firm/shared split is resolved server-side by `mergeConfigRow`, which hands
// back a row of exactly the shape that already existed. Nothing downstream —
// the calculator, the estimate routes, the PDF — has to know there are two
// tables now.

// The ".ts" extension is deliberate: this module is imported by
// tests/closingCostSettings.test.ts, which runs under
// `node --experimental-strip-types`, and that ESM resolver does not guess
// extensions. Same reasoning as tests/tsconfig.json; `allowImportingTsExtensions`
// is enabled in the root tsconfig, which is noEmit.
import {
  DEFAULT_LTT_TIERS,
  DEFAULT_MLTT_TIERS,
  DEFAULT_RATES,
  isTierArray,
  type Tier,
} from "./closingCosts.ts";

// ───────────────────────────── firms ─────────────────────────────

export const FIRM_KEYS = ["navawilson", "iclosed"] as const;
export type FirmKey = (typeof FIRM_KEYS)[number];

/**
 * Used when nothing else resolves — NOT the configured default.
 *
 * Every estimate this app has ever issued carried the Nava Wilson letterhead,
 * so falling back to it makes the firm split a no-op for existing files. The
 * staff-selectable default lives in `closing_cost_shared_rates.default_firm_key`.
 */
export const FALLBACK_FIRM_KEY: FirmKey = "navawilson";

export function isFirmKey(v: unknown): v is FirmKey {
  return typeof v === "string" && (FIRM_KEYS as readonly string[]).includes(v);
}

/** Coerce anything to a usable firm key. */
export function toFirmKey(v: unknown, fallback: FirmKey = FALLBACK_FIRM_KEY): FirmKey {
  return isFirmKey(v) ? v : fallback;
}

// ───────────────────────── statement types ─────────────────────────

export const STATEMENT_TYPE_KEYS = ["draft", "final"] as const;
export type StatementTypeKey = (typeof STATEMENT_TYPE_KEYS)[number];

export const FALLBACK_STATEMENT_TYPE: StatementTypeKey = "draft";

export function isStatementTypeKey(v: unknown): v is StatementTypeKey {
  return (
    typeof v === "string" && (STATEMENT_TYPE_KEYS as readonly string[]).includes(v)
  );
}

export function toStatementTypeKey(
  v: unknown,
  fallback: StatementTypeKey = FALLBACK_STATEMENT_TYPE,
): StatementTypeKey {
  return isStatementTypeKey(v) ? v : fallback;
}

// ───────────────────────── column ownership ─────────────────────────

/**
 * Statutory / third-party — one source of truth, identical for every firm.
 * These are the columns `closing_cost_shared_rates` owns.
 */
export const SHARED_RATE_COLUMNS = [
  "reg_transfer",
  "reg_mortgage",
  "hst_rate",
  "rebate_ontario_max",
  "rebate_toronto_max",
  "title_premium_base",
  "title_premium_rate",
  "title_premium_min",
  "ltt_tiers",
  "mltt_tiers",
] as const;

/** The firm's own charges — every one of them HST-taxable. */
export const FIRM_FEE_COLUMNS = [
  "legal_transfer",
  "legal_mortgage",
  "legal_title_submission",
  "admin_fee",
  "teraview",
  "sheriff",
] as const;

/** Printed on the PDF letterhead. */
export const LETTERHEAD_COLUMNS = [
  "firm_name",
  "firm_subtitle",
  "firm_address",
  "firm_phone",
  "firm_fax",
  "firm_hst_number",
] as const;

export type SharedRateColumn = (typeof SHARED_RATE_COLUMNS)[number];
export type FirmFeeColumn = (typeof FIRM_FEE_COLUMNS)[number];
export type LetterheadColumn = (typeof LETTERHEAD_COLUMNS)[number];

// ───────────────────────────── defaults ─────────────────────────────

/**
 * Nava Wilson's letterhead. iClosed is a DIVISION of the same firm, so it
 * shares the address, telephone, fax and HST number — only the name, badge and
 * brand colour differ.
 */
const SHARED_LETTERHEAD = {
  firm_subtitle: "Barristers and Solicitors",
  firm_address: "Suite 210, 10 Milner Business Court, Toronto, Ontario, M1B 3C6",
  firm_phone: "416-321-1100",
  firm_fax: "416-321-1107",
  firm_hst_number: "829252303RT0001",
} as const;

/**
 * Per-firm identity. `brand_color` resolves a pre-existing inconsistency: the
 * PDF drew #CE2028 while the admin UI used #C10007. Nava Wilson keeps the red
 * its statements have always been printed in.
 */
const FIRM_IDENTITY: Record<
  FirmKey,
  { label: string; firm_name: string; firm_badge: string; brand_color: string; sort_order: number }
> = {
  navawilson: {
    label: "Nava Wilson",
    firm_name: "NAVA WILSON PROFESSIONAL CORPORATION",
    firm_badge: "NAVA WILSON PC",
    brand_color: "#CE2028",
    sort_order: 0,
  },
  iclosed: {
    label: "iClosed",
    firm_name: "ICLOSED",
    firm_badge: "ICLOSED",
    brand_color: "#C10007",
    sort_order: 1,
  },
};

/** The code defaults shaped like a `closing_cost_shared_rates` row. */
export function defaultSharedRow(): Record<string, unknown> {
  const d = DEFAULT_RATES;
  return {
    id: null,
    label: "Statutory & third-party (shared by all firms)",
    reg_transfer: d.regTransfer,
    reg_mortgage: d.regMortgage,
    hst_rate: d.hstRate,
    rebate_ontario_max: d.rebateOntarioMax,
    rebate_toronto_max: d.rebateTorontoMax,
    title_premium_base: d.titlePremiumBase,
    title_premium_rate: d.titlePremiumRate,
    title_premium_min: d.titlePremiumMin,
    ltt_tiers: DEFAULT_LTT_TIERS,
    mltt_tiers: DEFAULT_MLTT_TIERS,
    default_firm_key: FALLBACK_FIRM_KEY,
    default_statement_type: FALLBACK_STATEMENT_TYPE,
    is_active: true,
    is_deleted: false,
  };
}

/** The code defaults shaped like a per-firm `closing_cost_config` row. */
export function defaultFirmRow(firmKey: FirmKey): Record<string, unknown> {
  const d = DEFAULT_RATES;
  const identity = FIRM_IDENTITY[firmKey] ?? FIRM_IDENTITY[FALLBACK_FIRM_KEY];
  return {
    id: null,
    firm_key: firmKey,
    label: identity.label,
    firm_badge: identity.firm_badge,
    brand_color: identity.brand_color,
    sort_order: identity.sort_order,
    legal_transfer: d.legalTransfer,
    legal_mortgage: d.legalMortgage,
    legal_title_submission: d.legalTitleSubmission,
    admin_fee: d.adminFee,
    teraview: d.teraview,
    sheriff: d.sheriff,
    firm_name: identity.firm_name,
    ...SHARED_LETTERHEAD,
    // Only the incumbent is active out of the box. A second active row would
    // break the OLD `.maybeSingle()` read still running in production until the
    // new build ships, so iClosed is activated deliberately from the settings
    // page rather than by default.
    is_active: firmKey === FALLBACK_FIRM_KEY,
    is_deleted: false,
  };
}

/** Every firm's default row, in display order. */
export function defaultFirmRows(): Record<string, unknown>[] {
  return FIRM_KEYS.map((key) => defaultFirmRow(key));
}

// ───────────────────────── statement types ─────────────────────────

export interface StatementTypeConfig {
  type_key: StatementTypeKey;
  /** Staff-facing tab label. */
  label: string;
  /** Heading printed on the PDF. */
  title: string;
  /** Heading shown on screen above the statement. */
  screen_heading: string;
  /** The bolded lead line of the disclaimer block. */
  disclaimer_intro: string;
  /** Optional extra paragraph under the disclaimers. */
  footer_note: string;
  show_watermark: boolean;
  watermark_text: string;
}

/**
 * Defaults are byte-identical to the strings that are hard-coded today
 * (closingCostPdf.ts and ClosingCostStatement.tsx), so nothing a client sees
 * moves until a staff member deliberately edits it.
 *
 * Only the lead line and an optional footer note are editable — DISCLAIMERS[1..4]
 * stay in the twin `closingCosts.ts` so the portal keeps rendering the same
 * legal text without a second source of truth.
 */
const STATEMENT_TYPE_DEFAULTS: Record<StatementTypeKey, StatementTypeConfig> = {
  draft: {
    type_key: "draft",
    label: "Draft estimate",
    title: "ESTIMATED CLOSING COSTS — RESIDENTIAL PURCHASE (ONTARIO)",
    screen_heading: "ESTIMATED STATEMENT OF ACCOUNT",
    disclaimer_intro:
      "This is an estimate for planning purposes only. Final figures will be set out in the Statement of Account before closing.",
    footer_note: "",
    show_watermark: true,
    watermark_text: "DRAFT",
  },
  final: {
    type_key: "final",
    label: "Final account",
    title: "STATEMENT OF ACCOUNT — RESIDENTIAL PURCHASE (ONTARIO)",
    screen_heading: "STATEMENT OF ACCOUNT",
    disclaimer_intro:
      "Figures are final subject to the Statement of Adjustments settled on closing.",
    footer_note: "",
    show_watermark: false,
    watermark_text: "DRAFT",
  },
};

export function defaultStatementType(key: StatementTypeKey): StatementTypeConfig {
  return { ...(STATEMENT_TYPE_DEFAULTS[key] ?? STATEMENT_TYPE_DEFAULTS.draft) };
}

export function defaultStatementTypes(): Record<StatementTypeKey, StatementTypeConfig> {
  return {
    draft: defaultStatementType("draft"),
    final: defaultStatementType("final"),
  };
}

/** DB row → `StatementTypeConfig`, filling any gap from the code defaults. */
export function statementTypeFromRow(
  row: Record<string, unknown> | null | undefined,
  key: StatementTypeKey,
): StatementTypeConfig {
  const d = defaultStatementType(key);
  if (!row) return d;
  const str = (value: unknown, fallback: string) => {
    const s = value === null || value === undefined ? "" : String(value);
    return s.trim() ? s : fallback;
  };
  return {
    type_key: key,
    label: str(row.label, d.label),
    title: str(row.title, d.title),
    screen_heading: str(row.screen_heading, d.screen_heading),
    disclaimer_intro: str(row.disclaimer_intro, d.disclaimer_intro),
    // A deliberately-cleared footer note must stay cleared, so this one does
    // NOT fall back on empty.
    footer_note:
      row.footer_note === null || row.footer_note === undefined
        ? d.footer_note
        : String(row.footer_note),
    show_watermark:
      typeof row.show_watermark === "boolean" ? row.show_watermark : d.show_watermark,
    watermark_text: str(row.watermark_text, d.watermark_text),
  };
}

// ───────────────────────────── the merge ─────────────────────────────

/**
 * Firm row + shared row → ONE flat snake_case row of exactly the shape
 * `ratesFromConfigRow` and `generateClosingCostPdf` already consume.
 *
 * Shared is applied LAST and by explicit key, which matters twice:
 *
 *  - Spreading the whole shared row would let its `id` / `label` / `created_at`
 *    clobber the firm's.
 *  - Shared-wins means `closing_cost_shared_rates` is authoritative from the
 *    moment it is seeded — including the window before the legacy statutory
 *    columns are dropped off `closing_cost_config`, when a firm row still
 *    carries its own stale copies of them.
 */
export function mergeConfigRow(
  firmRow: Record<string, unknown> | null | undefined,
  sharedRow: Record<string, unknown> | null | undefined,
  firmKey: FirmKey,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...defaultFirmRow(firmKey),
    ...defaultSharedRow(),
    ...(firmRow ?? {}),
  };

  if (sharedRow) {
    for (const key of SHARED_RATE_COLUMNS) {
      const value = sharedRow[key];
      if (value !== null && value !== undefined) merged[key] = value;
    }
  }

  // The firm row is the identity, so its own keys win over defaultSharedRow's.
  merged.firm_key = firmKey;
  merged.label = firmRow?.label ?? defaultFirmRow(firmKey).label;
  merged.id = firmRow?.id ?? null;
  return merged;
}

// ───────────────────────────── validators ─────────────────────────────

/**
 * Validate a bracket table. Returns an error message, or null when usable.
 *
 * A missing trailing open-ended band would silently under-tax every price above
 * the last cap, so it is rejected rather than coerced.
 *
 * Moved here from `closingCostConfig.ts` (and re-exported from there) so it can
 * be tested without a supabase client.
 */
export function tierError(label: string, value: unknown): string | null {
  if (!isTierArray(value)) {
    return `${label} must be an array of [cap, rate] pairs`;
  }
  const tiers = value as Tier[];
  if (tiers.length > 40) return `${label} has too many bands`;

  if (tiers[tiers.length - 1][0] !== null) {
    return `${label} must end with an open-ended band (leave the last cap blank)`;
  }

  let prev = 0;
  for (let i = 0; i < tiers.length; i++) {
    const [cap, rate] = tiers[i];
    if (rate < 0 || rate > 1) {
      return `${label} band ${i + 1}: rate must be between 0 and 1`;
    }
    if (cap === null) {
      if (i !== tiers.length - 1) {
        return `${label}: only the last band may be open-ended`;
      }
      continue;
    }
    if (cap <= prev) {
      return `${label} band ${i + 1}: each cap must be greater than the one before it`;
    }
    prev = cap;
  }
  return null;
}

/** Six-digit hex only — three-digit shorthand keeps `hexToRgb01` a two-line parse. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function hexColorError(label: string, value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return `${label} cannot be empty`;
  if (!HEX_COLOR.test(raw)) {
    return `${label} must be a 6-digit hex colour such as #C10007`;
  }
  return null;
}

export interface Rgb01 {
  r: number;
  g: number;
  b: number;
}

/** "#C10007" → pdf-lib's 0–1 channel triple. Invalid input yields `fallback`. */
export function hexToRgb01(value: unknown, fallback: Rgb01): Rgb01 {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!HEX_COLOR.test(raw)) return fallback;
  return {
    r: parseInt(raw.slice(1, 3), 16) / 255,
    g: parseInt(raw.slice(3, 5), 16) / 255,
    b: parseInt(raw.slice(5, 7), 16) / 255,
  };
}
