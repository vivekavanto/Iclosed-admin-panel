"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import {
  computeStatement,
  ratesFromConfigRow,
  type ClosingCostInputs,
} from "@/lib/closingCosts";
import {
  FIRM_FEE_COLUMNS,
  LETTERHEAD_COLUMNS,
  type StatementTypeConfig,
} from "@/lib/closingCostSettings";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";
import {
  ADJUST_INPUTS,
  ADJUST_PLACEHOLDERS,
  ESTIMATE_FLAG_BY_FIELD,
  OVERRIDE_FIELDS,
} from "@/components/closingCost/adjustFields";
import {
  BigMoney,
  ChoiceButton,
  Collapsible,
  PickerRow,
  SmallMoney,
  SmallText,
  amountText,
} from "@/components/closingCost/fields";
import Letterhead from "@/components/closingCost/Letterhead";
import StatementCard from "@/components/closingCost/StatementCard";

// The standalone closing-cost calculator.
//
// Same controls and the same statement as a deal's closing-cost page — it is
// literally the same components — but attached to NO file. Nothing is written:
// no lead, no deal, no `deal_closing_estimates` row. It exists so a clerk can
// answer "what would this cost?" for a caller, or sanity-check a set of figures,
// without first creating a file to hang the answer on.
//
// What is deliberately absent, and why: "Save & issue to client" and "Email to
// client" both mean "the client now has these figures", and that promise is only
// meaningful when there is a file to record it against and a portal for them to
// see it in. Issuing lives on the deal page, where it belongs. Here a clerk can
// print the working, and that is all.
//
// It lives at ONE address — /closing-cost-calculator — which is outside /admin
// and needs no login. Staff open it from the sidebar and get it inside the usual
// shell; the clerks the link is shared with open the same URL and get the page on
// its own. One page, one API pair (/api/calculator/*), so there is no second copy
// of the tool to drift out of step with this one.

const BRAND = "#C10007";

// NOT under /api/admin, so src/middleware.ts does not gate them: the same
// endpoints answer a logged-in admin and a clerk with no session.
const CONFIG_URL = "/api/calculator/config";
const PDF_URL = "/api/calculator/pdf";

type ConfigRow = Record<string, unknown>;

interface FirmOption {
  firm_key: string;
  label: string;
  firm_badge?: string | null;
  brand_color?: string | null;
}

type Toast = { message: string; type: "success" | "error" } | null;

/** Text kept in state so a half-typed value ("1080") isn't reformatted mid-edit. */
interface FormState {
  firmKey: string;
  statementType: string;
  price: string;
  deposit: string;
  mortgage: string;
  isToronto: boolean;
  isFirstTimeBuyer: boolean;
  /** A cash deal IS simply a zero mortgage; this only disables the field. */
  isCashDeal: boolean;
  titlePremiumOverride: string;
  /** Dollar figures that replace the bracket calculation. Blank = use it. */
  provincialLttOverride: string;
  municipalLttOverride: string;
  propertyTaxAdjustment: string;
  fileNo: string;
  purchasers: string;
  propertyAddress: string;
  closingDate: string;
  /**
   * Whether each provisional line still carries the ESTIMATE chip — the four
   * "Is estimate" checkboxes in the Adjust fees panel. They drive the chip on
   * screen, in the PDF and in the client's copy.
   */
  titlePremiumIsEstimate: boolean;
  teraviewIsEstimate: boolean;
  sheriffIsEstimate: boolean;
  propertyTaxIsEstimate: boolean;
  /** key → typed text; blank means "use the firm standard". */
  overrides: Record<string, string>;
}

const EMPTY_FORM: FormState = {
  firmKey: "",
  statementType: "draft",
  price: "",
  deposit: "",
  mortgage: "",
  isToronto: false,
  isFirstTimeBuyer: false,
  isCashDeal: false,
  titlePremiumOverride: "",
  provincialLttOverride: "",
  municipalLttOverride: "",
  propertyTaxAdjustment: "",
  fileNo: "",
  purchasers: "",
  propertyAddress: "",
  closingDate: "",
  titlePremiumIsEstimate: true,
  teraviewIsEstimate: true,
  sheriffIsEstimate: true,
  propertyTaxIsEstimate: true,
  overrides: {},
};

const QuickClosingCostCalculator: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [config, setConfig] = useState<ConfigRow | null>(null);
  const [configIsDefault, setConfigIsDefault] = useState(false);
  const [firms, setFirms] = useState<FirmOption[]>([]);
  const [statementTypes, setStatementTypes] = useState<StatementTypeConfig[]>([]);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  /**
   * True while the property-tax figure is still the firm's PLANNING placeholder
   * from Settings, untouched by anyone — see the per-deal calculator, which
   * applies exactly the same rule.
   */
  const [propertyTaxIsPlaceholder, setPropertyTaxIsPlaceholder] = useState(false);
  /** The placeholder "Final account" took away, so going back restores it. */
  const stashedPlaceholderRef = useRef<string | null>(null);

  const showToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 5000);
    },
    [],
  );

  // ─────────────────────────────── load ───────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(CONFIG_URL);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load the closing-cost settings");
      }

      const configRow = (data.config ?? null) as ConfigRow | null;
      setConfig(configRow);
      setConfigIsDefault(Boolean(data.config_is_default));
      setFirms(data.firms ?? []);
      setStatementTypes(data.statement_types ?? []);

      // The firm's planning figure for the Statement of Adjustments. Every
      // calculation here is new, so it always seeds — there is no saved answer
      // it could overwrite.
      const adjustmentDefault = amountText(configRow?.property_tax_default);
      setForm({
        ...EMPTY_FORM,
        firmKey: data.default_firm_key || "",
        propertyTaxAdjustment: adjustmentDefault,
      });
      setPropertyTaxIsPlaceholder(adjustmentDefault !== "");
      stashedPlaceholderRef.current = null;
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load the closing-cost settings",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ──────────────────────────── computation ───────────────────────────

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  /** Typing a figure makes it the clerk's answer, not the firm's placeholder. */
  const updatePropertyTax = (value: string) => {
    setPropertyTaxIsPlaceholder(false);
    stashedPlaceholderRef.current = null;
    update("propertyTaxAdjustment", value);
  };

  /**
   * Switching to "Final account" drops an untouched placeholder; switching back
   * to a draft restores it. A final account that silently shows $1,000 of
   * "property tax" nobody chose reads as a settled figure and is not one.
   */
  const updateStatementType = (value: string) => {
    if (value === "final" && propertyTaxIsPlaceholder) {
      stashedPlaceholderRef.current = form.propertyTaxAdjustment;
      setPropertyTaxIsPlaceholder(false);
      setForm((prev) => ({ ...prev, statementType: value, propertyTaxAdjustment: "" }));
      return;
    }
    if (
      value !== "final" &&
      stashedPlaceholderRef.current !== null &&
      form.propertyTaxAdjustment === ""
    ) {
      const restored = stashedPlaceholderRef.current;
      stashedPlaceholderRef.current = null;
      setPropertyTaxIsPlaceholder(true);
      setForm((prev) => ({
        ...prev,
        statementType: value,
        propertyTaxAdjustment: restored,
      }));
      return;
    }
    update("statementType", value);
  };

  const setOverride = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, overrides: { ...prev.overrides, [key]: value } }));
  };

  /** Numeric rate overrides, ready for the API. */
  const rateOverrides = useMemo(() => {
    const out: Record<string, number> = {};
    for (const field of OVERRIDE_FIELDS) {
      const parsed = parseAmountInput(form.overrides[field.key] ?? "");
      if (parsed === null) continue;
      out[field.key] = parsed;
    }
    return out;
  }, [form.overrides]);

  /**
   * The config for the firm currently selected — the merged default-firm row
   * with the chosen firm's own columns overlaid by key. Same construction as the
   * per-deal calculator, and for the same reason: a firm row may still carry
   * stale copies of the statutory columns, which must not win.
   */
  const activeConfig = useMemo(() => {
    const base = { ...(config ?? {}) };
    const firm = firms.find((f) => f.firm_key === form.firmKey) as
      | Record<string, unknown>
      | undefined;
    if (!firm) return base;
    for (const key of [...FIRM_FEE_COLUMNS, ...LETTERHEAD_COLUMNS] as string[]) {
      if (firm[key] !== null && firm[key] !== undefined) base[key] = firm[key];
    }
    base.firm_key = firm.firm_key;
    base.firm_badge = firm.firm_badge ?? base.firm_badge;
    base.brand_color = firm.brand_color ?? base.brand_color;
    return base;
  }, [config, firms, form.firmKey]);

  const rates = useMemo(
    () => ratesFromConfigRow({ ...activeConfig, ...rateOverrides }),
    [activeConfig, rateOverrides],
  );

  const activeStatementType = useMemo(
    () => statementTypes.find((t) => t.type_key === form.statementType) ?? null,
    [statementTypes, form.statementType],
  );

  /**
   * The "Is estimate" checkbox for a field, or undefined when that field has
   * none. Hidden on a final account: nothing there is provisional, so a chip
   * cannot appear whatever the box says, and showing a dead control would
   * suggest otherwise. The saved state is left alone so switching back to a
   * draft restores the ticks.
   */
  const estimateBox = (fieldKey: string) => {
    const flag = ESTIMATE_FLAG_BY_FIELD[fieldKey];
    if (!flag || form.statementType === "final") return undefined;
    return {
      checked: form[flag],
      onChange: (checked: boolean) => update(flag, checked),
    };
  };

  const inputs: ClosingCostInputs = useMemo(
    () => ({
      price: parseAmountInput(form.price) ?? 0,
      deposit: parseAmountInput(form.deposit) ?? 0,
      mortgage: form.isCashDeal ? 0 : (parseAmountInput(form.mortgage) ?? 0),
      isToronto: form.isToronto,
      isFirstTimeBuyer: form.isFirstTimeBuyer,
      titlePremiumOverride: parseAmountInput(form.titlePremiumOverride),
      provincialLttOverride: parseAmountInput(form.provincialLttOverride),
      municipalLttOverride: parseAmountInput(form.municipalLttOverride),
      propertyTaxAdjustment: parseAmountInput(form.propertyTaxAdjustment),
      // A final account states charges actually incurred, so nothing on it is
      // badged as an estimate. Mirrors buildEstimateRow on the server.
      isFinalAccount: form.statementType === "final",
      titlePremiumIsEstimate: form.titlePremiumIsEstimate,
      teraviewIsEstimate: form.teraviewIsEstimate,
      sheriffIsEstimate: form.sheriffIsEstimate,
      propertyTaxIsEstimate: form.propertyTaxIsEstimate,
    }),
    [form],
  );

  const statement = useMemo(() => computeStatement(inputs, rates), [inputs, rates]);

  const overrideCount =
    Object.keys(rateOverrides).length +
    ADJUST_INPUTS.filter((f) => parseAmountInput(form[f.key]) !== null).length;

  const finalNeedsPropertyTax =
    form.statementType === "final" &&
    parseAmountInput(form.propertyTaxAdjustment) === null;

  const isDraft = form.statementType !== "final";
  const accent = String(activeConfig.brand_color || BRAND);

  // ───────────────────────────── actions ─────────────────────────────

  /**
   * Print what is on screen.
   *
   * The bytes are generated from the posted figures and handed straight back —
   * nothing is stored, and no `pdf_url` exists to serve on a second click. The
   * server recomputes the statement from the raw inputs, so the PDF and the
   * page agree by construction rather than by trust.
   */
  const handleDownload = async () => {
    if (inputs.price <= 0) {
      showToast("Enter a purchase price before downloading the PDF", "error");
      return;
    }
    if (finalNeedsPropertyTax) {
      showToast(
        "A final account needs the property tax & common expense adjustment",
        "error",
      );
      return;
    }

    setDownloading(true);
    try {
      const res = await fetch(PDF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          firm_key: form.firmKey || null,
          statement_type: form.statementType || null,
          purchase_price: inputs.price,
          deposit_paid: inputs.deposit,
          mortgage_amount: inputs.mortgage,
          is_toronto: inputs.isToronto,
          is_first_time_buyer: inputs.isFirstTimeBuyer,
          title_premium_override: inputs.titlePremiumOverride,
          provincial_ltt_override: inputs.provincialLttOverride,
          municipal_ltt_override: inputs.municipalLttOverride,
          property_tax_adjustment: inputs.propertyTaxAdjustment,
          file_no_display: form.fileNo || null,
          purchasers: form.purchasers || null,
          property_address: form.propertyAddress || null,
          closing_date: form.closingDate || null,
          rate_overrides: rateOverrides,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not generate the PDF");
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `estimated-closing-costs${form.fileNo ? `-${form.fileNo}` : ""}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not generate the PDF",
        "error",
      );
    } finally {
      setDownloading(false);
    }
  };

  /** Clear per-file deviations, returning every figure to the calculated one. */
  const handleResetFees = () => {
    setForm((prev) => ({
      ...prev,
      overrides: {},
      titlePremiumOverride: "",
      provincialLttOverride: "",
      municipalLttOverride: "",
    }));
    showToast("Adjustments cleared — back to the calculated figures");
  };

  /** Back to an empty calculator. Nothing was saved, so nothing is lost but typing. */
  const handleStartOver = () => {
    if (!window.confirm("Clear these numbers and start a new calculation?")) return;
    void load();
  };

  // ────────────────────────────── render ──────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> Loading calculator…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center">
        <TriangleAlert size={28} className="mx-auto text-gray-300" />
        <p className="mt-3 text-sm text-gray-700">{loadError}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-5 text-sm font-semibold"
          style={{ color: BRAND }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 lg:px-8">
      {toast && (
        <div
          role="status"
          className={`fixed right-6 top-6 z-50 max-w-sm rounded-lg px-4 py-3 text-sm leading-snug text-white shadow-lg ${
            toast.type === "error" ? "bg-red-600" : "bg-gray-900"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Sticks below AppHeader for a signed-in admin and to the top of the
          window for a clerk, who has no header above them — ClientLayout sets
          --app-header-h only when it renders the staff shell, so this one rule
          covers both. Matches the deal page's action bar so the calculators feel
          like one tool. The chip is the important part: it says, permanently and
          in the place a clerk would look for a "Saved" badge, that this page
          never saves. */}
      <div
        style={{ top: "var(--app-header-h, 0px)" }}
        className="sticky z-20 -mx-4 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-slate-50/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
      >
        <span className="text-xs font-semibold text-gray-500">
          Quick calculator — not attached to a file
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-[11px] font-semibold text-gray-600 ring-1 ring-gray-200">
            Nothing is saved
          </span>
          <button
            type="button"
            onClick={handleStartOver}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-600 hover:border-gray-300 hover:text-gray-900"
          >
            <RotateCcw size={13} />
            Start over
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            title="Generates a PDF of exactly these figures. It is not stored and the client is not notified."
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {downloading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Download PDF
          </button>
        </div>
      </div>

      {configIsDefault && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            No closing-cost configuration has been saved yet — these figures use the
            built-in defaults. Set them under Settings → Closing costs.
          </span>
        </div>
      )}

      <Letterhead config={activeConfig} fileNo={form.fileNo} />

      <div className="mb-5 mt-6 max-w-[720px]">
        <h1 className="text-[30px] font-bold leading-tight tracking-tight text-gray-900">
          Closing cost calculator
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-relaxed text-gray-600">
          Enter a purchase price, the deposit already paid, and the mortgage amount to
          see an <b>estimate</b> of the funds a purchaser needs on closing. Use it for a
          quick answer on a call — to issue figures to a client, open their file and use
          the closing costs page there.
        </p>
      </div>

      {isDraft && (
        <div className="mb-6 flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/70 px-4 py-3.5">
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-amber-600 text-xs font-bold text-white">
            !
          </span>
          <p className="text-[13px] leading-relaxed text-amber-900">
            <strong className="font-bold">
              {activeStatementType?.disclaimer_intro ||
                "This is a draft for planning only — please do not send us any funds yet."}
            </strong>{" "}
            Final figures are calculated once the mortgage instructions arrive from the
            lender, and a signed Statement of Account with exact amounts goes out before
            closing.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        {/* ────────────────────────── Your numbers ────────────────────────── */}
        <section className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:sticky lg:top-[120px]">
          <div>
            <h2
              className="text-[12px] font-bold uppercase tracking-[0.09em]"
              style={{ color: accent }}
            >
              Your numbers
            </h2>
            <p className="mt-0.5 text-[12.5px] text-gray-500">
              Four quick details from the purchase agreement.
            </p>
          </div>

          {/* Firm + statement type — both lists come from Settings. */}
          <div className="flex flex-col gap-2.5 border-b border-gray-100 pb-3.5">
            <PickerRow
              label="Firm"
              options={firms.map((f) => ({ value: f.firm_key, label: f.label }))}
              value={form.firmKey}
              accent={accent}
              onChange={(v) => update("firmKey", v)}
            />
            <PickerRow
              label="Statement type"
              options={statementTypes.map((t) => ({
                value: t.type_key,
                label: t.label,
              }))}
              value={form.statementType}
              accent={accent}
              onChange={updateStatementType}
            />
          </div>

          <Collapsible
            title="File details"
            open={detailsOpen}
            onToggle={() => setDetailsOpen((o) => !o)}
          >
            <SmallText
              label="File number"
              value={form.fileNo}
              placeholder="26P-0000"
              accent={accent}
              onChange={(v) => update("fileNo", v)}
            />
            <SmallText
              label="Purchaser(s)"
              value={form.purchasers}
              placeholder="Full names as on the agreement"
              accent={accent}
              onChange={(v) => update("purchasers", v)}
            />
            <SmallText
              label="Closing date"
              value={form.closingDate}
              placeholder="YYYY-MM-DD"
              accent={accent}
              onChange={(v) => update("closingDate", v)}
            />
            <SmallText
              label="Property address"
              value={form.propertyAddress}
              placeholder="Street, City, Province, Postal Code"
              accent={accent}
              onChange={(v) => update("propertyAddress", v)}
            />
            <span className="text-[10.5px] text-gray-400">
              Appears on the PDF only — nothing here is written to a file.
            </span>
          </Collapsible>

          <BigMoney
            id="qc-price"
            label="Purchase price"
            value={form.price}
            accent={accent}
            onChange={(v) => update("price", v)}
          />
          <BigMoney
            id="qc-deposit"
            label="Deposit already paid"
            value={form.deposit}
            accent={accent}
            onChange={(v) => update("deposit", v)}
          />
          <BigMoney
            id="qc-mortgage"
            label="Mortgage amount"
            value={form.isCashDeal ? "0" : form.mortgage}
            accent={accent}
            hint="Enter 0 if this is a cash deal."
            onChange={(v) => {
              update("mortgage", v);
              if ((parseAmountInput(v) ?? 0) > 0) update("isCashDeal", false);
            }}
          />

          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-semibold text-gray-900">
              Where is the property?
            </span>
            <div className="flex flex-wrap gap-2">
              <ChoiceButton
                label="Elsewhere in Ontario"
                active={!form.isToronto}
                accent={accent}
                onClick={() => update("isToronto", false)}
              />
              <ChoiceButton
                label="City of Toronto"
                active={form.isToronto}
                accent={accent}
                onClick={() => update("isToronto", true)}
              />
            </div>
            <span className="text-[11.5px] text-gray-500">
              Toronto charges a second, municipal land transfer tax.
            </span>
          </div>

          <button
            type="button"
            onClick={() => update("isFirstTimeBuyer", !form.isFirstTimeBuyer)}
            className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left text-[13px] font-semibold transition ${
              form.isFirstTimeBuyer ? "bg-red-50/40" : "border-gray-200 hover:bg-gray-50"
            }`}
            style={form.isFirstTimeBuyer ? { borderColor: accent } : undefined}
            aria-pressed={form.isFirstTimeBuyer}
          >
            <span
              className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md border text-[11px] font-bold text-white"
              style={
                form.isFirstTimeBuyer
                  ? { backgroundColor: accent, borderColor: accent }
                  : { borderColor: "#d1d5db" }
              }
            >
              {form.isFirstTimeBuyer ? "✓" : ""}
            </span>
            <span className="leading-relaxed">
              First-time home buyer
              <span className="block text-[11.5px] font-normal text-gray-500">
                Applies the land transfer tax rebate — up to{" "}
                {formatCurrency(rates.rebateOntarioMax, { cents: false })} in Ontario,
                plus {formatCurrency(rates.rebateTorontoMax, { cents: false })} in
                Toronto.
              </span>
            </span>
          </button>

          <Collapsible
            title="Adjust fees"
            badge={overrideCount > 0 ? `${overrideCount} adjusted` : undefined}
            open={panelOpen || finalNeedsPropertyTax}
            onToggle={() => setPanelOpen((o) => !o)}
          >
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
              {ADJUST_INPUTS.map((field) => (
                <SmallMoney
                  key={field.key}
                  label={field.label}
                  value={form[field.key]}
                  accent={accent}
                  placeholder={ADJUST_PLACEHOLDERS[field.key](statement)}
                  estimate={estimateBox(field.key)}
                  onChange={(v) => update(field.key, v)}
                />
              ))}
              {OVERRIDE_FIELDS.map((field) => (
                <SmallMoney
                  key={field.key}
                  label={field.label}
                  value={form.overrides[field.key] ?? ""}
                  accent={accent}
                  placeholder={amountText(activeConfig[field.key])}
                  estimate={estimateBox(field.key)}
                  onChange={(v) => setOverride(field.key, v)}
                />
              ))}
              <SmallMoney
                label="Property tax & common expense adj."
                value={form.propertyTaxAdjustment}
                accent={accent}
                allowNegative
                placeholder={ADJUST_PLACEHOLDERS.propertyTaxAdjustment(statement)}
                badge={form.statementType === "final" ? "Required" : undefined}
                invalid={finalNeedsPropertyTax}
                estimate={estimateBox("propertyTaxAdjustment")}
                onChange={updatePropertyTax}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-[10.5px] leading-snug ${
                  finalNeedsPropertyTax ? "text-amber-700" : "text-gray-400"
                }`}
              >
                {finalNeedsPropertyTax
                  ? "A final account cannot go out carrying the planning placeholder — enter the property tax & common expense adjustment from the Statement of Adjustments."
                  : isDraft
                    ? "Leave blank to use the calculated amount. HST recalculates on the adjusted fees. The property tax adjustment is a planning figure until the Statement of Adjustments arrives, and may be negative if the seller is in arrears."
                    : "Leave blank to use the calculated amount. HST recalculates on the adjusted fees. The property tax adjustment may be negative if the seller is in arrears."}
              </span>
              <button
                type="button"
                onClick={handleResetFees}
                className="flex-none rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[10.5px] font-semibold text-gray-500 hover:border-gray-300 hover:text-gray-800"
              >
                <RotateCcw size={11} className="mr-1 inline" />
                Reset all
              </button>
            </div>
          </Collapsible>

          <div className="flex flex-col gap-2 pt-0.5">
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[13.5px] font-semibold text-white transition disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {downloading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              Download PDF
            </button>
            <span className="text-[11px] leading-snug text-gray-500">
              The PDF is generated from these figures and handed straight to you — it is
              not stored, and the client is not notified. To issue an estimate to a
              client, open their file and use its closing costs page.
            </span>
          </div>
        </section>

        {/* ─────────────────────────── The statement ─────────────────────────── */}
        <StatementCard
          statement={statement}
          accent={accent}
          isDraft={isDraft}
          statementType={activeStatementType}
        />
      </div>
    </div>
  );
};

export default QuickClosingCostCalculator;
