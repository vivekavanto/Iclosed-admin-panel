"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Loader2,
  RotateCcw,
  Save,
  Send,
  TriangleAlert,
} from "lucide-react";
import {
  computeStatement,
  ratesFromConfigRow,
  type ClosingCostInputs,
} from "@/lib/closingCosts";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";
import ClosingCostStatement from "@/components/shared/ClosingCostStatement";

// Staff-facing purchase closing-cost calculator for one file.
//
// Lives on its own route rather than inside DealDetail.tsx (which is already
// ~6k lines); that file only gains a link to here.
//
// The statement recalculates locally on every keystroke via computeStatement,
// which is the same pure module the server uses when saving — so the preview and
// the stored snapshot can never disagree.

const BRAND = "#C10007";

const inputClass =
  "w-full px-3 py-2.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

const feeInputClass =
  "w-full pl-6 pr-2 py-2 text-[13px] border border-gray-200 rounded-md focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white tabular-nums";

/** Per-file overridable rates, in the order they appear in the panel. */
const OVERRIDE_FIELDS: Array<{
  key: string;
  label: string;
  prefix: "$" | "%";
  /** Stored as a rate (0.13) but typed as a percentage (13). */
  asPercent?: boolean;
}> = [
  { key: "legal_transfer", label: "Legal fee — Transfer", prefix: "$" },
  { key: "legal_mortgage", label: "Legal fee — Mortgage", prefix: "$" },
  { key: "reg_transfer", label: "Registration — Transfer", prefix: "$" },
  { key: "reg_mortgage", label: "Registration — Mortgage", prefix: "$" },
  {
    key: "legal_title_submission",
    label: "Legal — title submission (part of legal fee)",
    prefix: "$",
  },
  { key: "teraview", label: "Teraview — searches & review", prefix: "$" },
  { key: "sheriff", label: "Sheriff's Certificates", prefix: "$" },
  { key: "admin_fee", label: "Admin fees", prefix: "$" },
  { key: "rebate_ontario_max", label: "First-time buyer rebate — Ontario (max)", prefix: "$" },
  { key: "rebate_toronto_max", label: "First-time buyer rebate — Toronto (max)", prefix: "$" },
  { key: "hst_rate", label: "HST rate", prefix: "%", asPercent: true },
];

type ConfigRow = Record<string, unknown>;

interface EstimateRow {
  id: string;
  purchase_price: number | string | null;
  deposit_paid: number | string | null;
  mortgage_amount: number | string | null;
  is_toronto: boolean;
  is_first_time_buyer: boolean;
  title_premium_override: number | string | null;
  file_no_display: string | null;
  rates_used: Record<string, unknown> | null;
  line_items: Record<string, unknown> | null;
  total_closing_costs: number | string | null;
  balance_due: number | string | null;
  status: "draft" | "issued";
  issued_at: string | null;
  pdf_url: string | null;
  updated_at: string | null;
}

interface DealSummary {
  id: string;
  file_number: string | null;
  type: string | null;
  status: string | null;
  price: number | null;
  property_address: string | null;
}

type Toast = { message: string; type: "success" | "error" } | null;

/** Text kept in state so a half-typed value ("1080") isn't reformatted mid-edit. */
interface FormState {
  price: string;
  deposit: string;
  mortgage: string;
  isToronto: boolean;
  isFirstTimeBuyer: boolean;
  titlePremiumOverride: string;
  fileNo: string;
  /** key → typed text; blank means "use the firm standard". */
  overrides: Record<string, string>;
}

const EMPTY_FORM: FormState = {
  price: "",
  deposit: "",
  mortgage: "",
  isToronto: false,
  isFirstTimeBuyer: false,
  titlePremiumOverride: "",
  fileNo: "",
  overrides: {},
};

function amountText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

const ClosingCostCalculator: React.FC<{ dealId: string }> = ({ dealId }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const [deal, setDeal] = useState<DealSummary | null>(null);
  const [config, setConfig] = useState<ConfigRow | null>(null);
  const [configIsDefault, setConfigIsDefault] = useState(false);
  const [issued, setIssued] = useState<EstimateRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // GAP-001: the draft's updated_at when we loaded it, sent back on save so the
  // API can reject the write if another clerk changed it in between.
  const draftUpdatedAtRef = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const showToast = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      setToast({ message, type });
      setTimeout(() => setToast(null), 3000);
    },
    [],
  );

  // ─────────────────────────────── load ───────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate`);
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load this file");
      }

      setDeal(data.deal ?? null);
      setConfig(data.config ?? null);
      setConfigIsDefault(Boolean(data.config_is_default));
      setIssued(data.latest_issued ?? null);

      const draft: EstimateRow | null = data.draft ?? null;
      draftUpdatedAtRef.current = draft?.updated_at ?? null;

      // A saved draft wins; otherwise fall back to the issued figures; otherwise
      // seed from the file itself. The Toronto / first-time flags from `prefill`
      // are hints only — a clerk always confirms them.
      const seed: EstimateRow | null = draft ?? data.latest_issued ?? null;
      const prefill = data.prefill ?? {};

      const storedOverrides =
        (seed?.rates_used?.rate_overrides as Record<string, unknown> | undefined) ?? {};
      const overrides: Record<string, string> = {};
      for (const field of OVERRIDE_FIELDS) {
        const raw = storedOverrides[field.key];
        if (raw === null || raw === undefined || raw === "") continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        overrides[field.key] = String(field.asPercent ? n * 100 : n);
      }

      setForm({
        price: seed ? amountText(seed.purchase_price) : amountText(prefill.purchase_price),
        deposit: seed ? amountText(seed.deposit_paid) : "",
        mortgage: seed ? amountText(seed.mortgage_amount) : "",
        isToronto: seed ? Boolean(seed.is_toronto) : Boolean(prefill.is_toronto),
        isFirstTimeBuyer: seed
          ? Boolean(seed.is_first_time_buyer)
          : Boolean(prefill.is_first_time_buyer),
        titlePremiumOverride: seed ? amountText(seed.title_premium_override) : "",
        fileNo: (seed?.file_no_display ?? prefill.file_no_display ?? "") || "",
        overrides,
      });
      setDirty(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load this file");
    } finally {
      setLoading(false);
    }
  }, [dealId]);

  useEffect(() => {
    void load();
  }, [load]);

  // ──────────────────────────── computation ───────────────────────────

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const setOverride = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, overrides: { ...prev.overrides, [key]: value } }));
    setDirty(true);
  };

  /** Numeric overrides, ready for the API (percentages converted back to rates). */
  const rateOverrides = useMemo(() => {
    const out: Record<string, number> = {};
    for (const field of OVERRIDE_FIELDS) {
      const parsed = parseAmountInput(form.overrides[field.key] ?? "");
      if (parsed === null) continue;
      out[field.key] = field.asPercent ? parsed / 100 : parsed;
    }
    return out;
  }, [form.overrides]);

  const rates = useMemo(
    () => ratesFromConfigRow({ ...(config ?? {}), ...rateOverrides }),
    [config, rateOverrides],
  );

  const inputs: ClosingCostInputs = useMemo(
    () => ({
      price: parseAmountInput(form.price) ?? 0,
      deposit: parseAmountInput(form.deposit) ?? 0,
      mortgage: parseAmountInput(form.mortgage) ?? 0,
      isToronto: form.isToronto,
      isFirstTimeBuyer: form.isFirstTimeBuyer,
      titlePremiumOverride: parseAmountInput(form.titlePremiumOverride),
    }),
    [form],
  );

  const statement = useMemo(() => computeStatement(inputs, rates), [inputs, rates]);

  /** The exact body both save and issue send. */
  const buildBody = useCallback(
    () => ({
      purchase_price: inputs.price,
      deposit_paid: inputs.deposit,
      mortgage_amount: inputs.mortgage,
      is_toronto: inputs.isToronto,
      is_first_time_buyer: inputs.isFirstTimeBuyer,
      title_premium_override: inputs.titlePremiumOverride,
      file_no_display: form.fileNo || null,
      rate_overrides: rateOverrides,
    }),
    [inputs, form.fileNo, rateOverrides],
  );

  // ───────────────────────────── actions ─────────────────────────────

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          expected_updated_at: draftUpdatedAtRef.current,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Save failed");
      }
      draftUpdatedAtRef.current = data.data?.updated_at ?? null;
      setDirty(false);
      showToast("Draft estimate saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleIssue = async () => {
    if (inputs.price <= 0) {
      showToast("Enter a purchase price before issuing the estimate", "error");
      return;
    }
    if (
      !window.confirm(
        "Issue this estimate to the client?\n\nThe figures and the rates behind them are frozen at this point, a PDF is generated, and the client can see it in their portal.",
      )
    ) {
      return;
    }
    setIssuing(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not issue the estimate");
      }
      showToast(
        data.pdf_error
          ? "Estimate issued — the PDF will be generated on download"
          : "Estimate issued to the client",
      );
      await load();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not issue the estimate",
        "error",
      );
    } finally {
      setIssuing(false);
    }
  };

  /**
   * Download via fetch rather than a plain link so a JSON error (no saved
   * estimate, rate limited) surfaces as a toast instead of dumping raw JSON into
   * a browser tab.
   */
  const handleDownload = async (which: "issued" | "draft") => {
    setDownloading(true);
    try {
      const qs = which === "draft" ? "?draft=1" : "";
      const res = await fetch(
        `/api/admin/deals/${dealId}/closing-estimate/pdf${qs}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || "Could not generate the PDF");
      }
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `estimated-closing-costs-${form.fileNo || dealId}.pdf`;
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

  /** Clear per-file deviations, returning every fee to the firm standard. */
  const handleResetFees = () => {
    setForm((prev) => ({ ...prev, overrides: {}, titlePremiumOverride: "" }));
    setDirty(true);
    showToast("Fees reset to the firm standard");
  };

  const overrideCount = Object.keys(rateOverrides).length;
  const busy = saving || issuing;

  // ────────────────────────────── render ──────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> Loading estimate…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl px-6 py-20 text-center">
        <TriangleAlert size={28} className="mx-auto text-gray-300" />
        <p className="mt-3 text-sm text-gray-700">{loadError}</p>
        <Link
          href="/admin/deals"
          className="mt-5 inline-block text-sm font-semibold"
          style={{ color: BRAND }}
        >
          Back to all files
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
      {toast && (
        <div
          role="status"
          className={`fixed right-6 top-6 z-50 rounded-lg px-4 py-3 text-sm text-white shadow-lg ${
            toast.type === "error" ? "bg-red-600" : "bg-gray-900"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href={`/admin/deals/${dealId}`}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft size={13} /> Back to file
          </Link>
          <h1 className="mt-2 text-xl font-bold text-gray-900">Closing cost estimate</h1>
          <p className="mt-1 text-xs text-gray-500">
            {deal?.file_number ? `File ${deal.file_number}` : "Purchase"}
            {deal?.property_address ? ` · ${deal.property_address}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {issued && (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-semibold text-green-700 ring-1 ring-green-200">
              Issued · {formatCurrency(Number(issued.total_closing_costs))}
            </span>
          )}
          <button
            type="button"
            onClick={() => handleDownload(issued && !dirty ? "issued" : "draft")}
            disabled={downloading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {downloading ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            Download PDF
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save draft
          </button>
          <button
            type="button"
            onClick={handleIssue}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: BRAND }}
          >
            {issuing ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Issue to client
          </button>
        </div>
      </div>

      {configIsDefault && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            No saved fee configuration was found, so the built-in firm defaults are being
            used. Review them under{" "}
            <Link href="/admin/settings/closing-costs" className="font-semibold underline">
              Settings → Closing Costs
            </Link>
            .
          </span>
        </div>
      )}

      {dirty && issued && (
        <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
          You have unsaved changes. The client still sees the estimate issued
          {issued.issued_at ? ` on ${issued.issued_at.slice(0, 10)}` : ""} until you issue a
          new one.
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        {/* ── Left: client inputs ── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              CLIENT INPUTS
            </h2>
            <p className="mt-1 text-[11px] text-gray-400">
              The figures your client provides.
            </p>

            <div className="mt-4 space-y-3.5">
              <MoneyField
                label="Purchase Price"
                hint="agreed price of the home"
                value={form.price}
                onChange={(v) => update("price", v)}
              />
              <MoneyField
                label="Deposit Paid"
                hint="already paid to the realtor/seller"
                value={form.deposit}
                onChange={(v) => update("deposit", v)}
              />
              <MoneyField
                label="Mortgage Amount"
                hint="amount advanced by the lender (0 if cash)"
                value={form.mortgage}
                onChange={(v) => update("mortgage", v)}
              />

              <div>
                <label className="block text-[13px] font-semibold text-gray-800">
                  Property Location
                  <span className="ml-1.5 font-normal text-gray-400">
                    — Toronto adds the municipal land transfer tax
                  </span>
                </label>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {[
                    { label: "Elsewhere in Ontario", toronto: false },
                    { label: "City of Toronto", toronto: true },
                  ].map((opt) => {
                    const active = form.isToronto === opt.toronto;
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        onClick={() => update("isToronto", opt.toronto)}
                        className={`rounded-lg border px-2 py-2 text-[12px] font-medium transition ${
                          active
                            ? "border-[#C10007] bg-red-50 text-[#C10007]"
                            : "border-gray-200 text-gray-600 hover:bg-gray-50"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={form.isFirstTimeBuyer}
                  onChange={(e) => update("isFirstTimeBuyer", e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#C10007]"
                />
                <span className="text-[12px] text-gray-700">
                  Are you a first-time home buyer?
                  <span className="mt-0.5 block text-[11px] text-gray-400">
                    Applies the land transfer tax rebate — up to{" "}
                    {formatCurrency(rates.rebateOntarioMax, { cents: false })} in Ontario,{" "}
                    {formatCurrency(rates.rebateTorontoMax, { cents: false })} in Toronto.
                  </span>
                </span>
              </label>

              <div>
                <label className="block text-[13px] font-semibold text-gray-800">
                  File No.
                  <span className="ml-1.5 font-normal text-gray-400">
                    — shown on the statement
                  </span>
                </label>
                <input
                  type="text"
                  value={form.fileNo}
                  onChange={(e) => update("fileNo", e.target.value)}
                  placeholder="26P-____"
                  className={`${inputClass} mt-2`}
                />
              </div>
            </div>
          </div>

          {/* ── Adjust fixed fees & rates ── */}
          <div className="rounded-xl border border-gray-200 bg-gray-50/60">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className="flex w-full items-center justify-between px-4 py-3 text-left"
            >
              <span className="text-[12px] font-bold" style={{ color: BRAND }}>
                Adjust fixed fees &amp; rates
                {overrideCount > 0 && (
                  <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-[#C10007]">
                    {overrideCount} changed
                  </span>
                )}
              </span>
              <ChevronDown
                size={15}
                className={`shrink-0 text-gray-400 transition ${panelOpen ? "rotate-180" : ""}`}
              />
            </button>

            {panelOpen && (
              <div className="border-t border-gray-200 px-4 py-4">
                <div className="grid grid-cols-2 gap-x-3 gap-y-3">
                  {OVERRIDE_FIELDS.map((field) => {
                    const standardRaw = config?.[field.key];
                    const standard = Number(standardRaw ?? 0);
                    const placeholder = field.asPercent
                      ? String(Number((standard * 100).toFixed(4)))
                      : String(standard);
                    return (
                      <div key={field.key}>
                        <label className="block text-[11px] font-semibold leading-snug text-gray-700">
                          {field.label}
                        </label>
                        <div className="relative mt-1">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-gray-400">
                            {field.prefix}
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={form.overrides[field.key] ?? ""}
                            onChange={(e) => setOverride(field.key, e.target.value)}
                            placeholder={placeholder}
                            className={feeInputClass}
                          />
                        </div>
                      </div>
                    );
                  })}

                  <div className="col-span-2">
                    <label className="block text-[11px] font-semibold leading-snug text-gray-700">
                      Title Ins. — Premium (estimate)
                    </label>
                    <div className="relative mt-1">
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[12px] text-gray-400">
                        $
                      </span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={form.titlePremiumOverride}
                        onChange={(e) => update("titlePremiumOverride", e.target.value)}
                        placeholder="auto"
                        className={feeInputClass}
                      />
                    </div>
                  </div>
                </div>

                {/* Required helper text — this is how staff know the override
                    behaviour without reading the code. */}
                <p className="mt-3 text-[11px] leading-relaxed text-gray-500">
                  Leave &ldquo;Title Ins. — Premium&rdquo; blank to use the automatic
                  estimate, or type the exact First Canadian Title quote to override it.
                  Every field above defaults to the firm standard; a value here applies to
                  this file only.
                </p>

                <button
                  type="button"
                  onClick={handleResetFees}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <RotateCcw size={13} /> Reset fees
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ── Right: the statement ── */}
        <div className="rounded-xl border border-gray-200 bg-white p-5 sm:p-6">
          <ClosingCostStatement
            statement={statement}
            caption={
              issued && !dirty
                ? `Issued${issued.issued_at ? ` ${issued.issued_at.slice(0, 10)}` : ""} — the client sees these figures.`
                : "Preliminary — for planning only. Final figures per the Statement of Account at closing."
            }
            firmBadge={String(config?.firm_name ?? "") ? "NAVA WILSON PC" : null}
          />
        </div>
      </div>
    </div>
  );
};

/** Labelled dollar input with a leading "$". */
const MoneyField: React.FC<{
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}> = ({ label, hint, value, onChange }) => (
  <div>
    <label className="block text-[13px] font-semibold text-gray-800">
      {label}
      {hint && <span className="ml-1.5 font-normal text-gray-400">— {hint}</span>}
    </label>
    <div className="relative mt-2">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
        $
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="0"
        className={`${inputClass} pl-7 tabular-nums`}
      />
    </div>
  </div>
);

export default ClosingCostCalculator;
