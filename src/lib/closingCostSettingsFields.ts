import { LINE_LABELS } from "@/lib/closingCosts";

// Field descriptions shared by the closing-cost settings cards.
//
// Kept out of the components so the three cards, the shell's live sample and
// the save-time validation all agree on which columns exist, how each is
// displayed (dollars vs percent vs raw rate) and how it converts between the
// stored value and the text in the input.

/** Editable form state — every field is held as a string while being typed. */
export type Draft = Record<string, string>;

export interface NumericField {
  key: string;
  label: string;
  hint?: string;
  prefix?: "$" | "%";
  /** Stored as a rate (0.13) but edited as a percentage (13). */
  asPercent?: boolean;
}

export interface FieldSection {
  title: string;
  note?: string;
  fields: NumericField[];
}

export const inputClass =
  "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

export const BRAND = "#C10007";

// ── per-firm: the firm's own charges, all of them HST-taxable ──────────

export const FIRM_SECTIONS: FieldSection[] = [
  {
    title: "Legal & Admin Fees",
    note: "One flat professional fee, charged whether or not the purchase is financed. Title submission is billed separately and prints under Title Insurance.",
    fields: [
      {
        key: "legal_fees",
        label: LINE_LABELS.legal_fees,
        hint: "the whole purchase, mortgage or not",
        prefix: "$",
      },
      { key: "legal_title_submission", label: LINE_LABELS.title_submission, prefix: "$" },
      { key: "admin_fee", label: LINE_LABELS.admin_fee, prefix: "$" },
    ],
  },
  {
    title: "Search & Review Charges",
    note: "Per firm rather than shared because HST is charged on them — they are the firm's own search-and-review supply, not a pure government pass-through.",
    fields: [
      { key: "teraview", label: LINE_LABELS.teraview, prefix: "$" },
      { key: "sheriff", label: LINE_LABELS.sheriff, prefix: "$" },
    ],
  },
];

/**
 * Text fields on the letterhead. `logo_url` is NOT here — it is written by the
 * upload route, not typed, and a required-non-empty text rule would block
 * saving a firm that has no logo.
 */
export const LETTERHEAD_FIELDS: Array<{
  key: string;
  label: string;
  hint?: string;
  wide?: boolean;
}> = [
  { key: "firm_name", label: "Firm name", wide: true },
  { key: "firm_subtitle", label: "Subtitle" },
  { key: "firm_badge", label: "Badge", hint: "the small chip beside \"Legal & Admin Fees\"" },
  { key: "firm_address", label: "Address", wide: true },
  { key: "firm_phone", label: "Telephone" },
  { key: "firm_fax", label: "Fax" },
  { key: "firm_hst_number", label: "HST number" },
];

// ── shared: statutory & third-party, none of it HST-taxable ───────────

export const SHARED_SECTIONS: FieldSection[] = [
  {
    title: "Government Registration",
    note: "The ServiceOntario e-registration tariff. Identical for every firm, and the mortgage registration only applies when there is a mortgage.",
    fields: [
      { key: "reg_transfer", label: LINE_LABELS.reg_transfer, prefix: "$" },
      { key: "reg_mortgage", label: LINE_LABELS.reg_mortgage, prefix: "$" },
    ],
  },
  {
    title: "Statement of Adjustments",
    note: "A planning figure only — it is not a fee, carries no HST, and stays out of \"Total closing costs\". Staff replace it per file with the real number once the seller's lawyer sends the Statement of Adjustments.",
    fields: [
      {
        key: "property_tax_default",
        label: LINE_LABELS.property_tax_adjustment,
        hint: "what a new estimate starts with",
        prefix: "$",
      },
    ],
  },
  {
    title: "Rates & Caps",
    fields: [
      {
        key: "hst_rate",
        label: "HST rate",
        hint: "charged on legal fees, admin fee, Teraview and Sheriff's only",
        prefix: "%",
        asPercent: true,
      },
      {
        key: "rebate_ontario_max",
        label: "First-time buyer rebate — Ontario (max)",
        prefix: "$",
      },
      {
        key: "rebate_toronto_max",
        label: "First-time buyer rebate — Toronto (max)",
        prefix: "$",
      },
    ],
  },
  {
    title: "Title Insurance Premium Estimate",
    note: "A firm approximation, not FCT's official rate table: max(minimum, base + price × rate). Staff can override it per file with the exact quote.",
    fields: [
      { key: "title_premium_base", label: "Base amount", prefix: "$" },
      {
        key: "title_premium_rate",
        label: "Rate on purchase price",
        hint: "0.000785 = 0.0785%",
      },
      { key: "title_premium_min", label: "Minimum premium", prefix: "$" },
    ],
  },
];

// ── statement types ───────────────────────────────────────────────────

export const STATEMENT_TEXT_FIELDS: Array<{
  key: string;
  label: string;
  hint?: string;
  multiline?: boolean;
}> = [
  { key: "title", label: "PDF title", hint: "the heading printed on the statement" },
  { key: "screen_heading", label: "On-screen heading" },
  {
    key: "disclaimer_intro",
    label: "Lead disclaimer",
    hint: "bolded above the standing legal text",
    multiline: true,
  },
  {
    key: "footer_note",
    label: "Footer note",
    hint: "optional; italic, under the disclaimers",
    multiline: true,
  },
];

// ── conversions ───────────────────────────────────────────────────────

export const FIRM_NUMERIC_FIELDS = FIRM_SECTIONS.flatMap((s) => s.fields);
export const SHARED_NUMERIC_FIELDS = SHARED_SECTIONS.flatMap((s) => s.fields);

/** DB row → editable text draft, for one set of numeric + text fields. */
export function rowToDraft(
  row: Record<string, unknown>,
  numericFields: NumericField[],
  textKeys: string[] = [],
): Draft {
  const draft: Draft = {};
  for (const field of numericFields) {
    const n = Number(row[field.key] ?? 0);
    if (!Number.isFinite(n)) {
      draft[field.key] = "";
      continue;
    }
    draft[field.key] = field.asPercent ? String(Number((n * 100).toFixed(6))) : String(n);
  }
  for (const key of textKeys) {
    draft[key] = String(row[key] ?? "");
  }
  return draft;
}

/** Draft → the numeric half of a PUT body. Returns the offending label on error. */
export function draftToNumericBody(
  draft: Draft,
  fields: NumericField[],
  parse: (raw: string) => number | null,
): { error?: string; body: Record<string, unknown> } {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const parsed = parse(draft[field.key] ?? "");
    if (parsed === null) return { error: `${field.label} must be a number`, body: {} };
    if (parsed < 0) return { error: `${field.label} cannot be negative`, body: {} };
    body[field.key] = field.asPercent ? parsed / 100 : parsed;
  }
  return { body };
}

/** "$0 – $55,000" / "$2,000,000 and above" */
export function bandLabel(
  prevCap: number,
  cap: number | null,
  format: (n: number) => string,
): string {
  const from = format(prevCap);
  if (cap === null) return `${from} and above`;
  return `${from} – ${format(cap)}`;
}
