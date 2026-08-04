// Server-side access to the closing-cost configuration: the per-firm rows, the
// shared statutory rates, and the statement-type copy.
//
// Lives here rather than in the route file so both the settings routes and the
// per-deal estimate routes read the same rows (a Next route module may only
// export HTTP handlers). The pure half — keys, defaults, the merge and the
// validators — is in `closingCostSettings.ts` so it can be unit-tested without
// a supabase client.
//
// ── Deploy-order safety ─────────────────────────────────────────────────────
// Migrations here are applied MANUALLY, so this module has to work both before
// and after the SQL runs. Every read degrades in a defined way:
//
//   firm_key column missing (42703)  → fall back to the legacy single-active
//                                      query and treat that row as the firm
//   table missing (42P01 / PGRST205) → schemaReady: false, code defaults
//   anything else                    → code defaults + logger.error
//
// The merge lets the shared row win, so `closing_cost_shared_rates` becomes the
// single source of truth for statutory values the moment it is seeded — even
// while `closing_cost_config` still carries its own stale copies of them.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import {
  FALLBACK_FIRM_KEY,
  FIRM_KEYS,
  defaultFirmRow,
  defaultFirmRows,
  defaultSharedRow,
  defaultStatementType,
  defaultStatementTypes,
  mergeConfigRow,
  statementTypeFromRow,
  toFirmKey,
  toStatementTypeKey,
  type FirmKey,
  type StatementTypeConfig,
  type StatementTypeKey,
} from "./closingCostSettings.ts";

export { tierError, hexColorError } from "./closingCostSettings.ts";

type Row = Record<string, unknown>;

/** Postgres/PostgREST codes meaning "that relation does not exist (yet)". */
const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205", "PGRST106"]);
/** "that column does not exist (yet)" — the pre-migration `firm_key` case. */
const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

function codeOf(error: { code?: string | null } | null): string {
  return String(error?.code ?? "");
}

function isMissingTable(error: { code?: string | null } | null): boolean {
  return MISSING_TABLE_CODES.has(codeOf(error));
}

function isMissingColumn(error: { code?: string | null } | null): boolean {
  return MISSING_COLUMN_CODES.has(codeOf(error));
}

/**
 * The code defaults shaped like a merged `closing_cost_config` row.
 *
 * Keeps its zero-argument call signature — the config PUT route seeds from it.
 */
export function defaultConfigRow(firmKey: FirmKey = FALLBACK_FIRM_KEY): Row {
  return mergeConfigRow(defaultFirmRow(firmKey), defaultSharedRow(), firmKey);
}

// ───────────────────────── shared statutory rates ─────────────────────────

export interface SharedRatesResult {
  row: Row;
  /** True when the row came from code defaults, not the database. */
  isDefault: boolean;
  /** False when `closing_cost_shared_rates` does not exist yet. */
  schemaReady: boolean;
}

export async function readSharedRates(): Promise<SharedRatesResult> {
  const { data, error } = await supabaseAdmin
    .from("closing_cost_shared_rates")
    .select("*")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) {
      // Pre-migration. Not an error — the caller keeps using whatever statutory
      // values are still on the firm row, which are the correct live ones.
      return { row: defaultSharedRow(), isDefault: true, schemaReady: false };
    }
    logger.error("[ClosingCostConfig] shared rates read failed:", error.message);
    return { row: defaultSharedRow(), isDefault: true, schemaReady: true };
  }
  if (!data) return { row: defaultSharedRow(), isDefault: true, schemaReady: true };
  return { row: data as Row, isDefault: false, schemaReady: true };
}

// ───────────────────────────── firm profiles ─────────────────────────────

export interface FirmsResult {
  rows: Row[];
  isDefault: boolean;
  /** False when `closing_cost_config.firm_key` does not exist yet. */
  schemaReady: boolean;
}

/** Every firm profile, in display order, always covering all FIRM_KEYS. */
export async function readFirms(): Promise<FirmsResult> {
  const { data, error } = await supabaseAdmin
    .from("closing_cost_config")
    .select("*")
    .eq("is_deleted", false)
    .order("sort_order", { ascending: true });

  if (error) {
    if (isMissingColumn(error) || isMissingTable(error)) {
      return { rows: defaultFirmRows(), isDefault: true, schemaReady: false };
    }
    logger.error("[ClosingCostConfig] firms read failed:", error.message);
    return { rows: defaultFirmRows(), isDefault: true, schemaReady: true };
  }

  const byKey = new Map<string, Row>();
  for (const row of (data ?? []) as Row[]) {
    const key = String(row.firm_key ?? "");
    if (key) byKey.set(key, row);
  }

  // Always return one row per known firm so the settings page can render a tab
  // for a firm whose row has not been seeded yet.
  const rows = FIRM_KEYS.map((key) => byKey.get(key) ?? defaultFirmRow(key));
  return { rows, isDefault: byKey.size === 0, schemaReady: true };
}

/**
 * One firm's row, tolerating a database that predates the firm split.
 *
 * `legacy` is true when the row came from the old single-active-row query, which
 * means the caller is running against un-migrated data.
 */
async function readFirmRow(
  firmKey: FirmKey,
): Promise<{ row: Row | null; isDefault: boolean; schemaReady: boolean }> {
  const { data, error } = await supabaseAdmin
    .from("closing_cost_config")
    .select("*")
    .eq("firm_key", firmKey)
    .eq("is_deleted", false)
    .maybeSingle();

  if (!error) {
    if (!data) return { row: null, isDefault: true, schemaReady: true };
    return { row: data as Row, isDefault: false, schemaReady: true };
  }

  if (isMissingColumn(error) || isMissingTable(error)) {
    // Pre-migration: there is exactly one active row and it is the incumbent.
    const legacy = await supabaseAdmin
      .from("closing_cost_config")
      .select("*")
      .eq("is_active", true)
      .eq("is_deleted", false)
      .maybeSingle();

    if (legacy.error || !legacy.data) {
      if (legacy.error && !isMissingTable(legacy.error)) {
        logger.error(
          "[ClosingCostConfig] legacy config read failed:",
          legacy.error.message,
        );
      }
      return { row: null, isDefault: true, schemaReady: false };
    }
    return { row: legacy.data as Row, isDefault: false, schemaReady: false };
  }

  logger.error("[ClosingCostConfig] firm read failed:", error.message);
  return { row: null, isDefault: true, schemaReady: true };
}

// ───────────────────────────── the merged read ─────────────────────────────

export interface ActiveConfigResult {
  /**
   * Firm row + shared row merged into ONE flat snake_case row of exactly the
   * shape `ratesFromConfigRow` and `generateClosingCostPdf` already consume.
   */
  row: Row;
  /** True when NEITHER side came from the database. Unchanged meaning. */
  isDefault: boolean;
  firmKey: FirmKey;
  firmIsDefault: boolean;
  sharedIsDefault: boolean;
  schemaReady: boolean;
}

/**
 * The configuration behind one estimate.
 *
 * Falls back to the code defaults (flagged `isDefault`) rather than throwing
 * when the migration hasn't been applied yet, so the calculator still produces
 * correct numbers on a fresh environment instead of 500-ing.
 *
 * With no argument it resolves the staff-selected default firm from
 * `closing_cost_shared_rates.default_firm_key`, which is seeded to the
 * incumbent — so every existing call site keeps producing today's letterhead
 * and today's figures.
 */
export async function readActiveConfig(
  firmKey?: FirmKey | string | null,
): Promise<ActiveConfigResult> {
  const shared = await readSharedRates();
  const resolvedKey = toFirmKey(
    firmKey ?? shared.row.default_firm_key,
    FALLBACK_FIRM_KEY,
  );

  const firm = await readFirmRow(resolvedKey);
  const row = mergeConfigRow(
    firm.row,
    shared.schemaReady ? shared.row : null,
    resolvedKey,
  );

  return {
    row,
    isDefault: firm.isDefault && shared.isDefault,
    firmKey: resolvedKey,
    firmIsDefault: firm.isDefault,
    sharedIsDefault: shared.isDefault,
    schemaReady: firm.schemaReady && shared.schemaReady,
  };
}

// ───────────────────────────── statement types ─────────────────────────────

export interface StatementTypesResult {
  types: Record<StatementTypeKey, StatementTypeConfig>;
  isDefault: boolean;
  schemaReady: boolean;
}

/**
 * Both statement types, always. A missing row is filled from the code defaults,
 * which are byte-identical to the strings hard-coded today — so nothing a client
 * sees changes until a staff member edits it.
 */
export async function readStatementTypes(): Promise<StatementTypesResult> {
  const { data, error } = await supabaseAdmin
    .from("closing_cost_statement_types")
    .select("*")
    .eq("is_deleted", false)
    .order("sort_order", { ascending: true });

  if (error) {
    if (!isMissingTable(error)) {
      logger.error("[ClosingCostConfig] statement types read failed:", error.message);
    }
    return {
      types: defaultStatementTypes(),
      isDefault: true,
      schemaReady: !isMissingTable(error),
    };
  }

  const byKey = new Map<string, Row>();
  for (const row of (data ?? []) as Row[]) {
    const key = String(row.type_key ?? "");
    if (key) byKey.set(key, row);
  }

  return {
    types: {
      draft: statementTypeFromRow(byKey.get("draft") ?? null, "draft"),
      final: statementTypeFromRow(byKey.get("final") ?? null, "final"),
    },
    isDefault: byKey.size === 0,
    schemaReady: true,
  };
}

/**
 * One statement type's copy. With no argument it resolves the staff-selected
 * default from `closing_cost_shared_rates.default_statement_type`.
 */
export async function readStatementType(
  key?: StatementTypeKey | string | null,
): Promise<StatementTypeConfig> {
  if (key) {
    const { types } = await readStatementTypes();
    return types[toStatementTypeKey(key)];
  }

  const [shared, all] = await Promise.all([readSharedRates(), readStatementTypes()]);
  const resolved = toStatementTypeKey(shared.row.default_statement_type);
  return all.types[resolved] ?? defaultStatementType(resolved);
}
