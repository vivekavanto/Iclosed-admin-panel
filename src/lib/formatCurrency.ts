// CAD currency formatting for the closing-cost statement.
//
// The statement is a fee account, so it needs cents by default — unlike the
// whole-dollar `money()` helper inside dealPdf.ts, which is left untouched on
// purpose (it is on the existing task/deal PDF path and changing it would risk
// a regression for no benefit).
//
// ⚠️ TWIN FILE: d:\iclosed_dev_web\src\lib\formatCurrency.ts — keep in sync.

export interface FormatCurrencyOptions {
  /** Show cents. Default true. */
  cents?: boolean;
  /** Render a negative amount as "-$4,000.00" rather than "($4,000.00)". */
  sign?: boolean;
}

/**
 * "$21,363.69" / "$21,364" / "-$4,000.00".
 *
 * Non-finite and nullish input renders as an em dash rather than "NaN", so a
 * half-typed input box never shows garbage.
 */
export function formatCurrency(
  value: number | null | undefined,
  options: FormatCurrencyOptions = {},
): string {
  const { cents = true, sign = true } = options;
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "—";
  }
  const n = Number(value);
  const digits = cents ? 2 : 0;
  try {
    const formatted = new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      // Intl renders negatives as "-$4,000.00"; keep that when `sign`, else
      // format the magnitude and let the caller add its own "less:" wording.
      currencyDisplay: "symbol",
    }).format(sign ? n : Math.abs(n));
    return formatted;
  } catch {
    const abs = Math.abs(n).toFixed(digits);
    return `${sign && n < 0 ? "-" : ""}$${abs.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  }
}

/** "1,080,000.00" — no currency symbol, for form inputs. */
export function formatAmountInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return "";
  }
  return String(Number(value));
}

/** Parse a typed amount ("$1,080,000.00", "1080000", "") to a number. */
export function parseAmountInput(raw: string): number | null {
  const cleaned = (raw ?? "").replace(/[^0-9.\-]/g, "").trim();
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
