// The presentation half of an estimate's frozen configuration.
//
// `rates_used` already freezes what the client was CHARGED. This freezes what
// they were charged it ON: the letterhead, the brand colour, the logo, the
// statement title, the disclaimer lead line, the footer note and the watermark.
//
// ── Why both halves are needed ──────────────────────────────────────────
// Settings → Closing costs promises "changing these affects new estimates only".
// Freezing the rates alone honoured that for the numbers and broke it for
// everything around them — editing a disclaimer rewrote the disclaimer on every
// statement already sent, as soon as anyone re-downloaded one.
//
// PURE by design: no Supabase, no React, no Date. Everything here is a function
// of its arguments, which is what lets `configVersionOf` be a stable digest and
// lets `tests/closingCostConfigSnapshot.test.ts` assert the whole contract.
//
// ⚠️ TWIN FILE. A copy lives in the customer portal repo at
//    d:\iclosed_dev_web\src\lib\closingCostConfigSnapshot.ts
// Any edit here MUST be applied there too. The two differ ONLY in their import
// specifiers — this side writes explicit `.ts` extensions for the node --test
// loader, the portal side does not — because `configVersionOf` must produce the
// same stamp on both sides or the same document would be labelled two ways.

// Explicit `.ts` extensions: this module is reachable from the node --test
// suite, whose ESM loader will not resolve an extensionless specifier. Same
// reason closingCostConfig.ts writes them.
import { ratesToSnapshot, type ClosingCostRates } from "./closingCosts.ts";
import {
  LETTERHEAD_COLUMNS,
  defaultStatementType,
  statementTypeFromRow,
  toStatementTypeKey,
  type StatementTypeConfig,
} from "./closingCostSettings.ts";

/**
 * Every config column that reaches the rendered document but is NOT a rate.
 *
 * `LETTERHEAD_COLUMNS` is reused rather than restated so a column added to the
 * letterhead is snapshotted automatically instead of being silently left live.
 */
export const PRESENTATION_COLUMNS = [
  "firm_key",
  "label",
  "firm_badge",
  "brand_color",
  "logo_url",
  ...LETTERHEAD_COLUMNS,
] as const;

export interface ConfigSnapshot {
  /** The resolved firm presentation — the PDF's letterhead and brand. */
  firm: Record<string, unknown>;
  /** The resolved statement-type copy — title, disclaimer, watermark. */
  statement_type: Record<string, unknown>;
}

/**
 * Freeze the presentation config behind one estimate.
 *
 * Values are copied verbatim, including empty strings: a deliberately-cleared
 * fax line must stay cleared on a re-render, so absence and emptiness are
 * distinguished here exactly as the settings screen distinguishes them.
 */
export function buildConfigSnapshot(
  configRow: Record<string, unknown> | null | undefined,
  statementType: StatementTypeConfig | null | undefined,
): ConfigSnapshot {
  const row = configRow ?? {};
  const firm: Record<string, unknown> = {};
  for (const key of PRESENTATION_COLUMNS) {
    const value = row[key];
    if (value !== undefined) firm[key] = value;
  }

  const type = statementType ?? defaultStatementType("draft");
  return {
    firm,
    statement_type: {
      type_key: type.type_key,
      label: type.label,
      title: type.title,
      screen_heading: type.screen_heading,
      disclaimer_intro: type.disclaimer_intro,
      footer_note: type.footer_note,
      show_watermark: type.show_watermark,
      watermark_text: type.watermark_text,
    },
  };
}

/** True when a stored value is a snapshot this module can render from. */
export function isConfigSnapshot(value: unknown): value is ConfigSnapshot {
  if (!value || typeof value !== "object") return false;
  const bag = value as Record<string, unknown>;
  return Boolean(bag.firm && typeof bag.firm === "object");
}

/**
 * A stored snapshot back into the shapes the renderers consume.
 *
 * Returns null when there is no usable snapshot, which is the signal for the
 * caller to fall back to the live config — the honest behaviour for a row
 * written before snapshots existed.
 */
export function configFromSnapshot(value: unknown): {
  config: Record<string, unknown>;
  statementType: StatementTypeConfig;
} | null {
  if (!isConfigSnapshot(value)) return null;

  const typeRow = (value.statement_type ?? null) as Record<string, unknown> | null;
  const key = toStatementTypeKey(typeRow?.type_key);
  // Routed through the same reader the live path uses, so a snapshot missing a
  // field fills from the code defaults rather than printing "undefined".
  const statementType = statementTypeFromRow(typeRow, key);

  return {
    config: { ...value.firm },
    statementType: { ...statementType, title: withoutRetiredTitleSuffix(statementType.title) },
  };
}

/**
 * The one piece of a frozen snapshot that is NOT replayed verbatim.
 *
 * Every statement heading used to end "— RESIDENTIAL PURCHASE (ONTARIO)". The
 * firm dropped it on 2026-08-12 (see the admin repo's
 * migrations/2026-08-12-statement-title-drop-property-qualifier.sql), but a
 * heading is frozen into `config_snapshot` at save time — so without this, the
 * same file would print with the qualifier or without it depending on the date
 * its estimate happened to be saved, and re-downloading an old draft would
 * silently contradict the new one beside it.
 *
 * Matched as an exact retired suffix rather than "anything in brackets": a title
 * a staff member deliberately writes in Settings must survive untouched. Nothing
 * that describes MONEY is normalised here — figures, badges and disclaimers stay
 * frozen — and the stored row is never rewritten, only what is rendered from it.
 */
const RETIRED_TITLE_SUFFIX = /\s*[—–-]\s*RESIDENTIAL\s+(?:PURCHASE|PROPERTY)\s*\(ONTARIO\)\s*$/i;

export function withoutRetiredTitleSuffix(title: string): string {
  return title.replace(RETIRED_TITLE_SUFFIX, "").trim();
}

// ─────────────────────────── the version stamp ───────────────────────────

/**
 * Deterministic JSON: object keys sorted, so two structurally identical configs
 * always serialise byte-identically regardless of the order the database or a
 * spread happened to produce them in.
 *
 * Without this the digest would change every time an unrelated column was added
 * to a SELECT, which would make the stamp meaningless.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

/**
 * FNV-1a, 32-bit, as 8 lowercase hex digits.
 *
 * A version tag, not a security primitive: it answers "was this produced from
 * the same configuration?", and nothing depends on it being hard to collide.
 * Chosen over a crypto hash so this module stays pure and dependency-free, and
 * so the stamp is short enough to print in a 6pt footer.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // >>> 0 after each step keeps this in unsigned 32-bit arithmetic; Math.imul
    // supplies the 32-bit multiply JS's `*` would lose precision on.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The stamp printed on the PDF and stored on the row: `v<calc>.<digest>`.
 *
 * Covers the calculation version, the effective rates AND the presentation, so
 * two documents carrying the same stamp were produced from the same
 * configuration in every respect that can change what the client reads.
 */
export function configVersionOf(
  rates: ClosingCostRates,
  snapshot: ConfigSnapshot,
): string {
  const ratesRow = ratesToSnapshot(rates);
  const calcVersion = ratesRow.calc_version;
  return `v${calcVersion}.${fnv1a(stableStringify({ rates: ratesRow, config: snapshot }))}`;
}
