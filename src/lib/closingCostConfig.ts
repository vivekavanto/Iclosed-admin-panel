// Server-side access to the firm's closing-cost rate configuration.
//
// Lives here rather than in the route file so both the settings route and the
// per-deal estimate routes can read the same active row (a Next route module may
// only export HTTP handlers).

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { DEFAULT_RATES, isTierArray, type Tier } from "./closingCosts";

/** The code defaults shaped like a `closing_cost_config` row. */
export function defaultConfigRow(): Record<string, unknown> {
  const d = DEFAULT_RATES;
  return {
    id: null,
    label: "Firm standard",
    reg_transfer: d.regTransfer,
    reg_mortgage: d.regMortgage,
    teraview: d.teraview,
    sheriff: d.sheriff,
    legal_transfer: d.legalTransfer,
    legal_mortgage: d.legalMortgage,
    legal_title_submission: d.legalTitleSubmission,
    admin_fee: d.adminFee,
    hst_rate: d.hstRate,
    rebate_ontario_max: d.rebateOntarioMax,
    rebate_toronto_max: d.rebateTorontoMax,
    title_premium_base: d.titlePremiumBase,
    title_premium_rate: d.titlePremiumRate,
    title_premium_min: d.titlePremiumMin,
    ltt_tiers: d.lttTiers,
    mltt_tiers: d.mlttTiers,
    firm_name: "NAVA WILSON PROFESSIONAL CORPORATION",
    firm_subtitle: "Barristers and Solicitors",
    firm_address: "Suite 210, 10 Milner Business Court, Toronto, Ontario, M1B 3C6",
    firm_phone: "416-321-1100",
    firm_fax: "416-321-1107",
    firm_hst_number: "829252303RT0001",
    is_active: true,
    is_deleted: false,
  };
}

/**
 * The single active config row.
 *
 * Falls back to the code defaults (flagged `isDefault`) rather than throwing
 * when the migration hasn't been applied yet, so the calculator still produces
 * correct numbers on a fresh environment instead of 500-ing.
 */
export async function readActiveConfig(): Promise<{
  row: Record<string, unknown>;
  isDefault: boolean;
}> {
  const { data, error } = await supabaseAdmin
    .from("closing_cost_config")
    .select("*")
    .eq("is_active", true)
    .eq("is_deleted", false)
    .maybeSingle();

  if (error) {
    logger.error("[ClosingCostConfig] read failed, using code defaults:", error.message);
    return { row: defaultConfigRow(), isDefault: true };
  }
  if (!data) return { row: defaultConfigRow(), isDefault: true };
  return { row: data as Record<string, unknown>, isDefault: false };
}

/**
 * Validate a bracket table. Returns an error message, or null when usable.
 *
 * A missing trailing open-ended band would silently under-tax every price above
 * the last cap, so it is rejected rather than coerced.
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
