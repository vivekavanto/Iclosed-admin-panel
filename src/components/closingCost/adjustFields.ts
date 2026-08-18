import { LINE_LABELS, type computeStatement } from "@/lib/closingCosts";
import { amountText } from "./fields";

// The contents of the "Adjust fees" panel, shared by the per-deal calculator and
// the standalone one so a fee that becomes adjustable becomes adjustable in both.

/**
 * Per-file rate overrides shown in the "Adjust fees" panel.
 *
 * Only the firm's own charges: these are deviations from the firm's standard
 * SCHEDULE, so they ride in `rate_overrides` and are frozen alongside the
 * effective rates. The land transfer tax, title premium and Statement of
 * Adjustments figure are also adjustable in the same panel, but they are
 * per-file INPUTS rather than rates, so they live on the estimate row itself —
 * see ADJUST_INPUTS below.
 *
 * The HST rate and the rebate caps are deliberately absent: they are statutory,
 * and a per-file "adjustment" to them produces a figure that is simply wrong
 * rather than merely different. They remain editable in Settings for everyone.
 */
// Labels come from LINE_LABELS so a field is named exactly like the line it
// moves — staff adjusting "Teraview — title searches & review" should not have
// to work out that it is the field called "Teraview searches".
export const OVERRIDE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "legal_title_submission", label: LINE_LABELS.title_submission },
  { key: "reg_transfer", label: LINE_LABELS.reg_transfer },
  { key: "reg_mortgage", label: LINE_LABELS.reg_mortgage },
  { key: "teraview", label: LINE_LABELS.teraview },
  { key: "sheriff", label: LINE_LABELS.sheriff },
  { key: "legal_fees", label: LINE_LABELS.legal_fees },
  { key: "admin_fee", label: LINE_LABELS.admin_fee },
];

/** The form fields the "Adjust fees" panel edits as plain dollar figures. */
export type FormNumberKey =
  | "titlePremiumOverride"
  | "provincialLttOverride"
  | "municipalLttOverride"
  | "propertyTaxAdjustment";

/**
 * The adjustable per-file inputs, keyed by their form field. Rendered in the
 * same grid as the rate overrides so staff see one list of adjustable numbers
 * rather than an internal distinction they have no reason to care about.
 */
export const ADJUST_INPUTS: Array<{ key: FormNumberKey; label: string }> = [
  { key: "provincialLttOverride", label: LINE_LABELS.ltt_provincial },
  { key: "municipalLttOverride", label: LINE_LABELS.ltt_municipal },
  { key: "titlePremiumOverride", label: LINE_LABELS.title_premium },
];

/**
 * The four provisional lines, and the form field that says whether each one is
 * still an estimate.
 *
 * Keyed by the "Adjust fees" field they sit under — `titlePremiumOverride` and
 * `propertyTaxAdjustment` are ADJUST_INPUTS-style per-file inputs, `teraview`
 * and `sheriff` are OVERRIDE_FIELDS rate keys. Nothing else is badgeable:
 * registrations and the firm's own fees are known amounts.
 */
export type EstimateFlagKey =
  | "titlePremiumIsEstimate"
  | "teraviewIsEstimate"
  | "sheriffIsEstimate"
  | "propertyTaxIsEstimate";

export const ESTIMATE_FLAG_BY_FIELD: Record<string, EstimateFlagKey> = {
  titlePremiumOverride: "titlePremiumIsEstimate",
  teraview: "teraviewIsEstimate",
  sheriff: "sheriffIsEstimate",
  propertyTaxAdjustment: "propertyTaxIsEstimate",
};

/** Placeholder for each adjustable input: the figure it would replace. */
export const ADJUST_PLACEHOLDERS: Record<
  FormNumberKey,
  (s: ReturnType<typeof computeStatement>) => string
> = {
  provincialLttOverride: (s) => amountText(s.detail.provincialLTT),
  municipalLttOverride: (s) => amountText(s.detail.municipalLTT),
  titlePremiumOverride: (s) => amountText(s.detail.titlePremium),
  propertyTaxAdjustment: (s) => amountText(s.detail.propertyTaxAdjustment),
};
