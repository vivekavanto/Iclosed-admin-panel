"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronDown,
  Download,
  Loader2,
  Mail,
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
import {
  FIRM_FEE_COLUMNS,
  LETTERHEAD_COLUMNS,
  type StatementTypeConfig,
} from "@/lib/closingCostSettings";
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
  property_tax_adjustment?: number | string | null;
  file_no_display: string | null;
  purchasers?: string | null;
  property_address?: string | null;
  closing_date?: string | null;
  firm_key?: string | null;
  statement_type?: string | null;
  last_emailed_at?: string | null;
  last_emailed_to?: string | null;
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
  /**
   * Not persisted — a cash deal IS simply a zero mortgage. Kept in form state
   * only so the mortgage field can be disabled while the box is ticked; on
   * reload it is derived back from the saved amount.
   */
  isCashDeal: boolean;
  titlePremiumOverride: string;
  propertyTaxAdjustment: string;
  fileNo: string;
  purchasers: string;
  propertyAddress: string;
  closingDate: string;
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
  propertyTaxAdjustment: "",
  fileNo: "",
  purchasers: "",
  propertyAddress: "",
  closingDate: "",
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
  const [firms, setFirms] = useState<FirmOption[]>([]);
  const [statementTypes, setStatementTypes] = useState<StatementTypeConfig[]>([]);
  const [emailTo, setEmailTo] = useState("");
  const [emailing, setEmailing] = useState(false);

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
      setFirms(data.firms ?? []);
      setStatementTypes(data.statement_types ?? []);

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

      const mortgageText = seed ? amountText(seed.mortgage_amount) : "";

      setForm({
        firmKey: seed?.firm_key || data.default_firm_key || "",
        statementType: seed?.statement_type || "draft",
        price: seed ? amountText(seed.purchase_price) : amountText(prefill.purchase_price),
        deposit: seed ? amountText(seed.deposit_paid) : "",
        mortgage: mortgageText,
        isToronto: seed ? Boolean(seed.is_toronto) : Boolean(prefill.is_toronto),
        isFirstTimeBuyer: seed
          ? Boolean(seed.is_first_time_buyer)
          : Boolean(prefill.is_first_time_buyer),
        // A saved estimate with no mortgage IS a cash deal — derive rather than
        // store, so the two can never disagree.
        isCashDeal: Boolean(seed) && (parseAmountInput(mortgageText) ?? 0) === 0,
        titlePremiumOverride: seed ? amountText(seed.title_premium_override) : "",
        propertyTaxAdjustment: seed ? amountText(seed.property_tax_adjustment) : "",
        fileNo: (seed?.file_no_display ?? prefill.file_no_display ?? "") || "",
        purchasers: (seed?.purchasers ?? prefill.purchasers ?? "") || "",
        propertyAddress:
          (seed?.property_address ?? prefill.property_address ?? "") || "",
        closingDate: (seed?.closing_date ?? prefill.closing_date ?? "") || "",
        overrides,
      });
      setEmailTo(
        (data.latest_issued?.last_emailed_to ?? prefill.client_email ?? "") || "",
      );
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

  /**
   * The config for the firm currently selected.
   *
   * `config` from the API is the merged row for the DEFAULT firm, so it already
   * carries the shared statutory values. Picking a different firm overlays only
   * that firm's own columns — deliberately by key rather than by spreading the
   * whole row, because before the legacy columns are dropped a firm row still
   * carries stale copies of the statutory ones, which must not win.
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

  const inputs: ClosingCostInputs = useMemo(
    () => ({
      price: parseAmountInput(form.price) ?? 0,
      deposit: parseAmountInput(form.deposit) ?? 0,
      // Ticking "cash deal" zeroes the advance rather than clearing the field,
      // so unticking it restores whatever the clerk had typed.
      mortgage: form.isCashDeal ? 0 : (parseAmountInput(form.mortgage) ?? 0),
      isToronto: form.isToronto,
      isFirstTimeBuyer: form.isFirstTimeBuyer,
      titlePremiumOverride: parseAmountInput(form.titlePremiumOverride),
      propertyTaxAdjustment: parseAmountInput(form.propertyTaxAdjustment),
    }),
    [form],
  );

  const statement = useMemo(() => computeStatement(inputs, rates), [inputs, rates]);

  /** The exact body both save and issue send. */
  const buildBody = useCallback(
    () => ({
      firm_key: form.firmKey || null,
      statement_type: form.statementType || null,
      purchase_price: inputs.price,
      deposit_paid: inputs.deposit,
      mortgage_amount: inputs.mortgage,
      is_toronto: inputs.isToronto,
      is_first_time_buyer: inputs.isFirstTimeBuyer,
      title_premium_override: inputs.titlePremiumOverride,
      property_tax_adjustment: inputs.propertyTaxAdjustment,
      file_no_display: form.fileNo || null,
      purchasers: form.purchasers || null,
      property_address: form.propertyAddress || null,
      closing_date: form.closingDate || null,
      rate_overrides: rateOverrides,
    }),
    [inputs, form, rateOverrides],
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

  /**
   * Email the ISSUED estimate to the client.
   *
   * Deliberately refuses while there are unsaved edits: what the client would
   * receive is the frozen snapshot, not what is on screen, and sending a figure
   * the clerk can see they have just changed is how wrong numbers reach inboxes.
   */
  const handleEmail = async () => {
    const to = emailTo.trim();
    if (!to) {
      showToast("Enter an email address to send to", "error");
      return;
    }
    if (!issued) {
      showToast("Issue the estimate before emailing it", "error");
      return;
    }
    if (dirty) {
      showToast("Save and issue your changes before emailing", "error");
      return;
    }
    if (
      !window.confirm(
        `Email this estimate to ${to}?\n\nThey will receive the issued figures with the statement PDF attached.`,
      )
    ) {
      return;
    }

    setEmailing(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to, estimate_id: issued.id }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not send the email");
      }
      showToast(
        data.pdf_attached
          ? `Estimate sent to ${data.sent_to}`
          : `Estimate sent to ${data.sent_to} — the PDF could not be attached`,
        data.pdf_attached ? "success" : "error",
      );
      await load();
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : "Could not send the email",
        "error",
      );
    } finally {
      setEmailing(false);
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
          {/* Firm & statement type — these decide the letterhead, the fee
              schedule and the wording, so they sit above the figures. */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              FIRM &amp; STATEMENT
            </h2>

            <div className="mt-3.5 space-y-3.5">
              {firms.length > 1 && (
                <div>
                  <label className="block text-[13px] font-semibold text-gray-800">
                    Firm
                    <span className="ml-1.5 font-normal text-gray-400">
                      — letterhead &amp; fee schedule
                    </span>
                  </label>
                  <SegmentedControl
                    options={firms.map((f) => ({ value: f.firm_key, label: f.label }))}
                    value={form.firmKey}
                    onChange={(v) => update("firmKey", v)}
                  />
                </div>
              )}

              <div>
                <label className="block text-[13px] font-semibold text-gray-800">
                  Statement type
                </label>
                <SegmentedControl
                  options={statementTypes.map((t) => ({
                    value: t.type_key,
                    label: t.label,
                  }))}
                  value={form.statementType}
                  onChange={(v) => update("statementType", v)}
                />
                {activeStatementType && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                    {activeStatementType.disclaimer_intro}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* File details — printed at the head of the statement. */}
          <details className="group rounded-xl border border-gray-200 bg-white" open>
            <summary className="flex cursor-pointer list-none items-center justify-between p-5">
              <span
                className="text-[11px] font-bold tracking-wide"
                style={{ color: BRAND }}
              >
                FILE DETAILS
                <span className="ml-1.5 font-normal text-gray-400">— optional</span>
              </span>
              <ChevronDown
                size={15}
                className="text-gray-400 transition-transform group-open:rotate-180"
              />
            </summary>
            <div className="space-y-3.5 px-5 pb-5">
              <TextField
                label="File number"
                value={form.fileNo}
                onChange={(v) => update("fileNo", v)}
              />
              <TextField
                label="Purchaser(s)"
                hint="as they should appear on the statement"
                value={form.purchasers}
                onChange={(v) => update("purchasers", v)}
              />
              <TextField
                label="Property address"
                value={form.propertyAddress}
                onChange={(v) => update("propertyAddress", v)}
              />
              <div>
                <label className="block text-[13px] font-semibold text-gray-800">
                  Closing date
                </label>
                <input
                  type="date"
                  value={form.closingDate}
                  onChange={(e) => update("closingDate", e.target.value)}
                  className={`${inputClass} mt-1.5`}
                />
              </div>
              <p className="text-[11px] leading-relaxed text-gray-400">
                Captured on this estimate rather than read from the file, so a later
                correction never rewrites a statement already sent.
              </p>
            </div>
          </details>

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
                hint="amount advanced by the lender"
                value={form.isCashDeal ? "" : form.mortgage}
                disabled={form.isCashDeal}
                placeholder={form.isCashDeal ? "0 — cash deal" : undefined}
                onChange={(v) => update("mortgage", v)}
              />

              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-gray-200 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={form.isCashDeal}
                  onChange={(e) => update("isCashDeal", e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#C10007]"
                />
                <span className="text-[13px] leading-snug text-gray-700">
                  This is a cash deal — no mortgage
                  <span className="mt-0.5 block text-[11px] text-gray-400">
                    Removes the mortgage registration, the mortgage portion of the legal
                    fee, and the lender&rsquo;s advance.
                  </span>
                </span>
              </label>

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

              {/* A Statement of Adjustments item, so it is kept apart from the
                  fee overrides below — it is the client's money, not a charge. */}
              <MoneyField
                label="Property tax adjustment"
                hint="from the Statement of Adjustments; negative credits the buyer"
                value={form.propertyTaxAdjustment}
                allowNegative
                onChange={(v) => update("propertyTaxAdjustment", v)}
              />
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
                    // The selected firm's standard, so switching firms updates
                    // the "firm standard" placeholders too.
                    const standardRaw = activeConfig?.[field.key];
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

          {/* ── Email the estimate ── */}
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              EMAIL TO THE CLIENT
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              Sends the issued figures with the statement PDF attached. What the client
              receives is the frozen snapshot, not what is on screen.
            </p>

            <input
              type="email"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="client@example.com"
              className={`${inputClass} mt-3`}
            />

            <button
              type="button"
              onClick={handleEmail}
              disabled={emailing || !issued || dirty}
              className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ backgroundColor: BRAND }}
            >
              {emailing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Mail size={13} />
              )}
              Send the estimate
            </button>

            {!issued && (
              <p className="mt-2 text-[11px] text-gray-400">
                Issue the estimate first — there is nothing frozen to send yet.
              </p>
            )}
            {issued && dirty && (
              <p className="mt-2 text-[11px] text-amber-700">
                You have unsaved changes. Issue them before emailing, or the client will
                receive the previous figures.
              </p>
            )}
            {issued?.last_emailed_at && (
              <p className="mt-2 text-[11px] text-gray-400">
                Last sent to {issued.last_emailed_to} on{" "}
                {issued.last_emailed_at.slice(0, 10)}.
              </p>
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
                : undefined
            }
            firmBadge={String(activeConfig?.firm_badge ?? "").trim() || null}
            heading={activeStatementType?.screen_heading}
            // Follows the selected statement type, so picking "Final account"
            // stops printing the draft's "this is an estimate" wording.
            disclaimerIntro={activeStatementType?.disclaimer_intro}
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
  disabled?: boolean;
  placeholder?: string;
  /** Property tax can credit the buyer, so its field must accept a minus sign. */
  allowNegative?: boolean;
  onChange: (value: string) => void;
}> = ({ label, hint, value, disabled, placeholder, allowNegative, onChange }) => (
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
        inputMode={allowNegative ? "text" : "decimal"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "0"}
        className={`${inputClass} pl-7 tabular-nums disabled:bg-gray-50 disabled:text-gray-400`}
      />
    </div>
  </div>
);

/** Labelled free-text input for the statement header fields. */
const TextField: React.FC<{
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
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`${inputClass} mt-1.5`}
    />
  </div>
);

/** Two-or-more mutually exclusive choices rendered as a pill row. */
const SegmentedControl: React.FC<{
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}> = ({ options, value, onChange }) => (
  <div className="mt-2 grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(options.length, 1)}, minmax(0, 1fr))` }}>
    {options.map((opt) => {
      const active = value === opt.value;
      return (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
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
);

export default ClosingCostCalculator;
