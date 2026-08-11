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
  DISCLAIMERS,
  LINE_TOOLTIPS,
  computeStatement,
  ratesFromConfigRow,
  type ClosingCostInputs,
  type StatementLine,
} from "@/lib/closingCosts";
import {
  FIRM_FEE_COLUMNS,
  LETTERHEAD_COLUMNS,
  type StatementTypeConfig,
} from "@/lib/closingCostSettings";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";
import { docDownloadHref } from "@/lib/blobPrivacy";

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
const OVERRIDE_FIELDS: Array<{ key: string; label: string }> = [
  { key: "legal_title_submission", label: "FCT submission & review" },
  { key: "reg_transfer", label: "Registration of transfer" },
  { key: "reg_mortgage", label: "Registration of mortgage" },
  { key: "teraview", label: "Teraview searches" },
  { key: "sheriff", label: "Sheriff's certificates" },
  { key: "legal_fees", label: "Legal fees" },
  { key: "admin_fee", label: "Admin fee" },
];

/**
 * The adjustable per-file inputs, keyed by their FormState field. Rendered in
 * the same grid as the rate overrides so staff see one list of adjustable
 * numbers rather than an internal distinction they have no reason to care
 * about.
 */
const ADJUST_INPUTS: Array<{ key: FormNumberKey; label: string }> = [
  { key: "provincialLttOverride", label: "Ontario provincial LTT" },
  { key: "municipalLttOverride", label: "Toronto municipal LTT" },
  { key: "titlePremiumOverride", label: "Title insurance premium" },
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
  provincial_ltt_override?: number | string | null;
  municipal_ltt_override?: number | string | null;
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
  /** Dollar figures that replace the bracket calculation. Blank = use it. */
  provincialLttOverride: string;
  municipalLttOverride: string;
  propertyTaxAdjustment: string;
  fileNo: string;
  purchasers: string;
  propertyAddress: string;
  closingDate: string;
  /** key → typed text; blank means "use the firm standard". */
  overrides: Record<string, string>;
}

/** The FormState fields the "Adjust fees" panel edits as plain dollar figures. */
type FormNumberKey =
  | "titlePremiumOverride"
  | "provincialLttOverride"
  | "municipalLttOverride"
  | "propertyTaxAdjustment";

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [fileDetailsOpen, setFileDetailsOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  /** Key of the statement line whose tooltip is showing; only ever one. */
  const [tip, setTip] = useState<string | null>(null);

  const [deal, setDeal] = useState<DealSummary | null>(null);
  const [config, setConfig] = useState<ConfigRow | null>(null);
  const [configIsDefault, setConfigIsDefault] = useState(false);
  const [issued, setIssued] = useState<EstimateRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [firms, setFirms] = useState<FirmOption[]>([]);
  const [statementTypes, setStatementTypes] = useState<StatementTypeConfig[]>([]);
  const [emailTo, setEmailTo] = useState("");
  const [emailing, setEmailing] = useState(false);

  /**
   * True while the property-tax figure is still the firm's PLANNING placeholder
   * from Settings, untouched by anyone.
   *
   * A final account may not carry it, so switching to "Final account" clears an
   * untouched placeholder rather than letting it ride into a statement of
   * account as if it were a settled figure. A value the clerk typed, or one
   * loaded off a saved estimate, is a real answer and is never cleared.
   */
  const [propertyTaxIsPlaceholder, setPropertyTaxIsPlaceholder] = useState(false);

  /**
   * The placeholder that switching to "Final account" took away, so switching
   * back to a draft puts it back.
   *
   * Without this, glancing at Final and returning would silently cost the clerk
   * the firm's planning figure — a toggle that inspects one thing must not
   * quietly destroy another.
   */
  const stashedPlaceholderRef = useRef<string | null>(null);

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

      // Read once and reused below, so the config the page renders and the
      // config the property-tax default is taken from can never be two
      // different objects.
      const configRow = (data.config ?? null) as ConfigRow | null;

      setDeal(data.deal ?? null);
      setConfig(configRow);
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
        overrides[field.key] = String(n);
      }

      const mortgageText = seed ? amountText(seed.mortgage_amount) : "";

      // The firm's planning figure for the Statement of Adjustments, from
      // Settings → Closing costs. It seeds a NEW estimate only: once an estimate
      // exists its own figure wins, including a deliberately-cleared one, so
      // raising the default never silently re-adds an adjustment a clerk removed.
      const adjustmentDefault = amountText(configRow?.property_tax_default);

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
        provincialLttOverride: seed ? amountText(seed.provincial_ltt_override) : "",
        municipalLttOverride: seed ? amountText(seed.municipal_ltt_override) : "",
        propertyTaxAdjustment: seed
          ? amountText(seed.property_tax_adjustment)
          : adjustmentDefault,
        fileNo: (seed?.file_no_display ?? prefill.file_no_display ?? "") || "",
        purchasers: (seed?.purchasers ?? prefill.purchasers ?? "") || "",
        propertyAddress:
          (seed?.property_address ?? prefill.property_address ?? "") || "",
        closingDate: (seed?.closing_date ?? prefill.closing_date ?? "") || "",
        overrides,
      });
      // Only a figure nobody has chosen is a placeholder. A saved estimate's own
      // value — including a deliberately-cleared one — is an answer.
      setPropertyTaxIsPlaceholder(!seed && adjustmentDefault !== "");
      stashedPlaceholderRef.current = null;
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

  /** Typing a figure makes it the clerk's answer, not the firm's placeholder. */
  const updatePropertyTax = (value: string) => {
    setPropertyTaxIsPlaceholder(false);
    stashedPlaceholderRef.current = null;
    update("propertyTaxAdjustment", value);
  };

  /**
   * Switching to "Final account" drops an untouched placeholder; switching back
   * to a draft restores it.
   *
   * Carrying it forward would be worse than an empty field: a final statement
   * that silently shows $1,000 of "property tax" nobody chose reads as a
   * settled figure and is not one. Emptying it makes the omission visible, and
   * both the issue and the email routes refuse a final without it.
   */
  const updateStatementType = (value: string) => {
    if (value === "final" && propertyTaxIsPlaceholder) {
      stashedPlaceholderRef.current = form.propertyTaxAdjustment;
      setPropertyTaxIsPlaceholder(false);
      setForm((prev) => ({
        ...prev,
        statementType: value,
        propertyTaxAdjustment: "",
      }));
      setDirty(true);
      return;
    }

    // Back to a draft, and the field is still as Final left it — put the firm's
    // planning figure back rather than making them retype it.
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
      setDirty(true);
      return;
    }

    update("statementType", value);
  };

  const setOverride = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, overrides: { ...prev.overrides, [key]: value } }));
    setDirty(true);
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
      provincialLttOverride: parseAmountInput(form.provincialLttOverride),
      municipalLttOverride: parseAmountInput(form.municipalLttOverride),
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
      provincial_ltt_override: inputs.provincialLttOverride,
      municipal_ltt_override: inputs.municipalLttOverride,
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
    if (finalNeedsPropertyTax) {
      showToast(
        "A final account needs the property tax & common expense adjustment",
        "error",
      );
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

  /** Clear per-file deviations, returning every figure to the calculated one. */
  const handleResetFees = () => {
    setForm((prev) => ({
      ...prev,
      overrides: {},
      titlePremiumOverride: "",
      provincialLttOverride: "",
      municipalLttOverride: "",
    }));
    setDirty(true);
    showToast("Adjustments cleared — back to the calculated figures");
  };

  const overrideCount =
    Object.keys(rateOverrides).length +
    ADJUST_INPUTS.filter((f) => parseAmountInput(form[f.key]) !== null).length;

  /**
   * A final account with no Statement of Adjustments figure.
   *
   * Mirrors `finalStatementBlocker` on the server, which is what actually
   * enforces this — the point of checking here is to say so before the clerk
   * clicks, not to be the gate.
   */
  const finalNeedsPropertyTax =
    form.statementType === "final" &&
    parseAmountInput(form.propertyTaxAdjustment) === null;
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

  // The firm's own colour drives the accent, so switching firm re-skins the
  // page the same way it re-skins the PDF letterhead.
  const accent = String(activeConfig.brand_color || BRAND);
  const isDraft = form.statementType !== "final";
  const firmName = String(activeConfig.firm_name || activeConfig.label || "");
  const logoUrl = String(activeConfig.logo_url || "");
  const todayStr = new Date().toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  /** A line's tooltip copy, or null when it has none. */
  const tipFor = (key: string) => LINE_TOOLTIPS[key] ?? null;

  const tipHandlers = (key: string) => ({
    onMouseEnter: () => setTip(key),
    onMouseLeave: () => setTip((k) => (k === key ? null : k)),
    onFocus: () => setTip(key),
    onBlur: () => setTip((k) => (k === key ? null : k)),
  });

  /** One "label … amount" row, with its info bubble. */
  const renderLine = (line: StatementLine, muted = false) => {
    const copy = tipFor(line.key);
    // A "not final yet" marker. The title premium carries its own badge from
    // the calculation (it disappears the moment the real FCT quote is pasted in);
    // the rest are only provisional while the statement is still a draft.
    // The engine decides which lines are provisional, so the screen, the PDF
    // and a frozen snapshot always agree. See CALC_VERSION 7.
    const badge = line.badge ?? null;

    return (
      <div
        key={line.key}
        className={`flex items-baseline justify-between gap-3.5 py-1.5 text-[13.5px] ${
          muted ? "text-gray-500" : "text-gray-900"
        }`}
      >
        <span className="inline-flex max-w-[76%] flex-wrap items-center">
          {line.label}
          {badge && (
            <span className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-amber-700">
              {badge}
            </span>
          )}
          {copy && (
            <span className="relative ml-1.5 inline-flex">
              <span
                tabIndex={0}
                role="note"
                aria-label={copy}
                {...tipHandlers(line.key)}
                className="flex h-[15px] w-[15px] cursor-help items-center justify-center rounded-full text-[10px] font-bold"
                style={{ backgroundColor: `${accent}1a`, color: accent }}
              >
                i
              </span>
              {tip === line.key && (
                <span className="absolute bottom-6 left-1/2 z-20 w-[250px] -translate-x-1/2 rounded-[10px] bg-gray-900 px-3 py-2.5 text-[11.5px] font-normal leading-relaxed text-white shadow-xl">
                  {copy}
                </span>
              )}
            </span>
          )}
        </span>
        <span className="whitespace-nowrap tabular-nums">
          {formatCurrency(line.amount)}
        </span>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-[1120px] px-4 py-7 sm:px-6 lg:px-8">
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

      {/* Admin chrome — the workflow actions that have no place on the client's
          statement, kept above the letterhead so the document below reads as the
          document. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/admin/deals/${dealId}`}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-500 hover:text-gray-800"
        >
          <ArrowLeft size={13} /> Back to file
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {issued && (
            <span className="rounded-full bg-green-50 px-2.5 py-1 text-[11px] font-semibold text-green-700 ring-1 ring-green-200">
              Issued · {formatCurrency(Number(issued.total_closing_costs))}
            </span>
          )}
          {dirty && (
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-amber-200">
              Unsaved changes
            </span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save draft
          </button>
          <button
            type="button"
            onClick={handleIssue}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: accent }}
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
            No closing-cost configuration has been saved yet — these figures use the
            built-in defaults. Set them under Settings → Closing costs.
          </span>
        </div>
      )}

      {/* ── Letterhead ── every value from the firm's profile in Settings. */}
      <div className="flex flex-wrap items-start justify-between gap-5 border-b border-gray-200 pb-4">
        <div className="flex flex-col gap-1.5">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={docDownloadHref(logoUrl)}
              alt={firmName}
              className="h-[30px] w-auto object-contain"
            />
          ) : (
            <span className="text-2xl font-bold leading-none tracking-tight text-gray-900">
              {firmName}
            </span>
          )}
          <div className="text-[12.5px] leading-relaxed text-gray-500">
            {String(activeConfig.firm_address || "")}
            <br />
            Tel: {String(activeConfig.firm_phone || "—")} · Fax:{" "}
            {String(activeConfig.firm_fax || "—")} · HST #{" "}
            {String(activeConfig.firm_hst_number || "—")}
          </div>
        </div>
        <div className="text-right text-xs leading-loose text-gray-500">
          <div>
            File No.{" "}
            <span className="font-semibold tabular-nums text-gray-900">
              {form.fileNo || deal?.file_number || "—"}
            </span>
          </div>
          <div>Prepared {todayStr}</div>
        </div>
      </div>

      <div className="mb-5 mt-6 max-w-[720px]">
        <h1 className="text-[30px] font-bold leading-tight tracking-tight text-gray-900">
          Closing cost estimate
        </h1>
        <p className="mt-2.5 text-[14.5px] leading-relaxed text-gray-600">
          Enter your purchase price, the deposit you have already paid, and your
          mortgage amount, and we will provide an <b>estimate</b> of how much you need
          to bring at your closing.
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
            Your final figures are calculated once we receive the mortgage instructions
            from your bank, and we will send you a signed Statement of Account with exact
            amounts before closing.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        {/* ────────────────────────── Your numbers ────────────────────────── */}
        <section className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:sticky lg:top-6">
          <div>
            <h2
              className="text-[12px] font-bold uppercase tracking-[0.09em]"
              style={{ color: accent }}
            >
              Your numbers
            </h2>
            <p className="mt-0.5 text-[12.5px] text-gray-500">
              Four quick details from your purchase agreement.
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

          {/* File details */}
          <Collapsible
            title="File details"
            open={fileDetailsOpen}
            onToggle={() => setFileDetailsOpen((o) => !o)}
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
              Appears on the estimate and the PDF statement.
            </span>
          </Collapsible>

          <BigMoney
            id="cc-price"
            label="Purchase price"
            value={form.price}
            accent={accent}
            onChange={(v) => update("price", v)}
          />
          <BigMoney
            id="cc-deposit"
            label="Deposit already paid"
            value={form.deposit}
            accent={accent}
            onChange={(v) => update("deposit", v)}
          />
          <BigMoney
            id="cc-mortgage"
            label="Mortgage amount"
            value={form.isCashDeal ? "0" : form.mortgage}
            accent={accent}
            hint="Enter 0 if this is a cash deal."
            onChange={(v) => {
              update("mortgage", v);
              // Typing a real amount takes the file back off "cash", so the two
              // can never disagree about what the client is borrowing.
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
              I am a first-time home buyer
              <span className="block text-[11.5px] font-normal text-gray-500">
                Applies the land transfer tax rebate — up to{" "}
                {formatCurrency(rates.rebateOntarioMax, { cents: false })} in Ontario,
                plus {formatCurrency(rates.rebateTorontoMax, { cents: false })} in
                Toronto.
              </span>
            </span>
          </button>

          {/* Adjust fees.
              The Statement of Adjustments figure rides in this panel with the
              rest of the editable numbers, but it is NOT one of the firm's
              charges — it is money the buyer owes the seller, it lands on the
              client's balance, and on a final account it is mandatory. So it
              keeps its Required chip, and a final account missing it forces the
              panel open rather than letting it hide behind "Add". */}
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

          <div className="flex flex-wrap gap-2.5 pt-0.5">
            <button
              type="button"
              onClick={() => setEmailOpen((o) => !o)}
              className="min-w-[150px] flex-1 rounded-xl border border-gray-200 bg-white px-4 py-3 text-[13.5px] font-semibold text-gray-800 transition hover:border-gray-300"
            >
              <Mail size={14} className="mr-1.5 inline" />
              Email to client
            </button>
            <button
              type="button"
              onClick={() => handleDownload(issued && !dirty ? "issued" : "draft")}
              disabled={downloading}
              className="inline-flex min-w-[150px] flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[13.5px] font-semibold text-white transition disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {downloading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Download size={14} />
              )}
              Download PDF
            </button>
          </div>

          {emailOpen && (
            <div className="flex flex-col gap-2 rounded-xl border border-dashed border-red-200 bg-red-50/30 px-3.5 py-3">
              <label
                htmlFor="cc-email"
                className="text-[12px] font-semibold text-gray-600"
              >
                Send the issued statement to
              </label>
              <input
                id="cc-email"
                type="email"
                value={emailTo}
                onChange={(e) => setEmailTo(e.target.value)}
                placeholder="client@email.com"
                className={`${inputClass} text-[13.5px]`}
              />
              <button
                type="button"
                onClick={handleEmail}
                disabled={emailing}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50"
                style={{ backgroundColor: accent }}
              >
                {emailing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Send size={13} />
                )}
                Send email
              </button>
              <span className="text-[10.5px] leading-snug text-gray-400">
                Sends the ISSUED figures with the PDF attached — not what is on screen.
                Issue your changes first.
              </span>
            </div>
          )}
        </section>

        {/* ─────────────────────────── The statement ─────────────────────────── */}
        <section className="rounded-2xl border border-gray-200 bg-white px-7 py-6 shadow-sm">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-gray-200 pb-3.5">
            <div>
              <h2 className="text-[17px] font-bold tracking-tight text-gray-900">
                Closing costs
              </h2>
              <p className="mt-0.5 text-[12.5px] text-gray-500">
                {isDraft
                  ? "Draft estimate — for planning only, before your lender's instructions arrive."
                  : "Final account — figures confirmed against your lender's mortgage instructions."}
              </p>
            </div>
          </div>

          {/* Rendered from the computed groups, so a line that does not apply —
              no mortgage registration on a cash deal, no municipal tax outside
              Toronto — is absent rather than shown as zero. */}
          {statement.groups.map((group) => (
            <div key={group.key}>
              <h3
                className="mb-1 mt-5 border-b border-gray-100 pb-1.5 text-[11px] font-bold uppercase tracking-[0.11em]"
                style={{ color: accent }}
              >
                {group.title}
              </h3>
              {group.lines.map((line) =>
                renderLine(line, line.amount < 0 || line.key.startsWith("rebate_")),
              )}
              {group.key === "legal" && (
                <div className="mt-1.5 border-t border-dashed border-gray-200 pt-2">
                  {renderLine({
                    key: "hst",
                    label: "HST",
                    amount: statement.hst.amount,
                  })}
                </div>
              )}
            </div>
          ))}

          {statement.propertyTax && (
            <div>
              <h3
                className="mb-1 mt-5 border-b border-gray-100 pb-1.5 text-[11px] font-bold uppercase tracking-[0.11em]"
                style={{ color: accent }}
              >
                Adjustments
              </h3>
              {renderLine(statement.propertyTax)}
            </div>
          )}

          <div className="mt-2 flex items-baseline justify-between gap-3.5 border-t border-gray-900 pt-2.5">
            <span className="text-[13.5px] font-semibold text-gray-900">
              Total closing costs
            </span>
            <span className="text-[14.5px] font-semibold tabular-nums text-gray-900">
              {formatCurrency(statement.total)}
            </span>
          </div>

          {/* Funds needed — the number the client actually acts on. */}
          <div
            className="mt-3.5 rounded-xl border p-4.5 px-5 py-4"
            style={{ borderColor: `${accent}33`, backgroundColor: `${accent}0a` }}
          >
            <div
              className="mb-2 text-[11px] font-bold uppercase tracking-[0.11em]"
              style={{ color: accent }}
            >
              Funds you&apos;ll need on closing
            </div>
            <BalanceRow
              label="Purchase price"
              value={formatCurrency(statement.balance.purchasePrice)}
            />
            <BalanceRow
              muted
              label="less deposit already paid"
              value={signedCurrency(-statement.balance.depositPaid)}
            />
            <BalanceRow
              muted
              label="less mortgage advance from your lender"
              value={signedCurrency(-statement.balance.mortgageAmount)}
            />
            {statement.balance.propertyTaxAdjustment !== 0 && (
              <BalanceRow
                label="plus adjustments (above)"
                value={signedCurrency(statement.balance.propertyTaxAdjustment)}
              />
            )}
            <BalanceRow
              label="plus closing costs (above)"
              value={signedCurrency(statement.balance.closingCosts)}
            />
            <div
              className="mt-2.5 flex items-baseline justify-between border-t pt-3"
              style={{ borderColor: `${accent}33` }}
            >
              <span className="text-[14px] font-bold text-gray-900">
                Estimated balance due on closing
              </span>
              <span
                className="text-[22px] font-bold tabular-nums"
                style={{ color: accent }}
              >
                {formatCurrency(statement.balance.balanceDue)}
              </span>
            </div>
          </div>

          <p className="mt-3.5 border-t border-gray-200 pt-3.5 text-[11.5px] leading-relaxed text-gray-500">
            <strong className="text-gray-600">
              {activeStatementType?.disclaimer_intro || DISCLAIMERS[0]}
            </strong>{" "}
            {DISCLAIMERS.slice(1).join(" ")}
            {activeStatementType?.footer_note ? ` ${activeStatementType.footer_note}` : ""}
          </p>
        </section>
      </div>
    </div>
  );
};

/**
 * Lines that are still provisional while the statement is a draft.
 *
 * The title premium is NOT here — it carries its own badge from the calculation,
 * which disappears the moment the exact FCT quote is entered, and that is more
 * precise than "is this a draft".
 */
/** Placeholder for each adjustable input: the figure it would replace. */
const ADJUST_PLACEHOLDERS: Record<
  FormNumberKey,
  (s: ReturnType<typeof computeStatement>) => string
> = {
  provincialLttOverride: (s) => amountText(s.detail.provincialLTT),
  municipalLttOverride: (s) => amountText(s.detail.municipalLTT),
  titlePremiumOverride: (s) => amountText(s.detail.titlePremium),
  propertyTaxAdjustment: (s) => amountText(s.detail.propertyTaxAdjustment),
};

/** "+ $1,200.00" / "– $50,000.00" / "—" for zero. */
function signedCurrency(n: number): string {
  const v = Math.round(n * 100) / 100;
  if (v === 0) return "—";
  return `${v < 0 ? "– " : "+ "}${formatCurrency(Math.abs(v))}`;
}

const BalanceRow: React.FC<{ label: string; value: string; muted?: boolean }> = ({
  label,
  value,
  muted,
}) => (
  <div
    className={`flex justify-between py-1 text-[13.5px] ${
      muted ? "text-gray-500" : "text-gray-800"
    }`}
  >
    <span>{label}</span>
    <span className="tabular-nums">{value}</span>
  </div>
);

/** A labelled row of mutually exclusive pill buttons. */
const PickerRow: React.FC<{
  label: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  accent: string;
  onChange: (value: string) => void;
}> = ({ label, options, value, accent, onChange }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-[11px] font-bold uppercase tracking-[0.09em] text-gray-400">
      {label}
    </span>
    <div className="flex flex-wrap gap-1.5">
      {options.map((opt) => (
        <ChoiceButton
          key={opt.value}
          label={opt.label}
          active={value === opt.value}
          accent={accent}
          onClick={() => onChange(opt.value)}
        />
      ))}
    </div>
  </div>
);

const ChoiceButton: React.FC<{
  label: string;
  active: boolean;
  accent: string;
  onClick: () => void;
}> = ({ label, active, accent, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-lg border px-3 py-2 text-[12.5px] font-semibold transition ${
      active ? "bg-red-50/50" : "border-gray-200 text-gray-600 hover:bg-gray-50"
    }`}
    style={active ? { borderColor: accent, color: accent } : undefined}
  >
    {label}
  </button>
);

/** A dashed "— optional" disclosure block. */
const Collapsible: React.FC<{
  title: string;
  badge?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}> = ({ title, badge, open, onToggle, children }) => (
  <div className="flex flex-col gap-2 rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-3 py-2.5">
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center justify-between gap-2 text-left"
    >
      <span className="text-[10px] font-bold uppercase tracking-[0.09em] text-gray-400">
        {title}{" "}
        <span className="font-medium normal-case tracking-normal">— optional</span>
        {badge && (
          <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold normal-case tracking-normal text-amber-700">
            {badge}
          </span>
        )}
      </span>
      <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold text-gray-500">
        {open ? "Hide" : "Add"}
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </span>
    </button>
    {open && <div className="flex flex-col gap-2">{children}</div>}
  </div>
);

/** The three headline amounts. */
const BigMoney: React.FC<{
  id: string;
  label: string;
  value: string;
  accent: string;
  hint?: string;
  onChange: (value: string) => void;
}> = ({ id, label, value, accent, hint, onChange }) => (
  <div className="flex flex-col gap-1.5">
    <label
      htmlFor={id}
      className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-gray-900"
    >
      {label}
    </label>
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-3.5 font-semibold text-gray-400">
        $
      </span>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-gray-50/40 py-3 pl-7 pr-3.5 text-base font-semibold tabular-nums text-gray-900 outline-none transition focus:bg-white"
        onFocus={(e) => {
          e.currentTarget.style.borderColor = accent;
          e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}22`;
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "";
          e.currentTarget.style.boxShadow = "";
        }}
      />
    </div>
    {hint && <span className="text-[11.5px] text-gray-500">{hint}</span>}
  </div>
);

/** A compact $ field for the Adjust fees grid. */
const SmallMoney: React.FC<{
  label: string;
  value: string;
  accent: string;
  placeholder?: string;
  allowNegative?: boolean;
  /** Small chip beside the label, e.g. "Required" on a final account. */
  badge?: string;
  /** Draws the field as unanswered; the panel footer reads back the reason. */
  invalid?: boolean;
  onChange: (value: string) => void;
}> = ({
  label,
  value,
  accent,
  placeholder,
  allowNegative,
  badge,
  invalid,
  onChange,
}) => (
  <div className="flex flex-col gap-1">
    <label className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-semibold leading-tight text-gray-600">
      {label}
      {badge && (
        <span
          className="rounded px-1 py-px text-[8.5px] font-bold uppercase tracking-wider"
          style={{ backgroundColor: `${accent}18`, color: accent }}
        >
          {badge}
        </span>
      )}
    </label>
    <div className="relative flex items-center">
      <span className="pointer-events-none absolute left-2 text-[11px] text-gray-400">
        $
      </span>
      <input
        type="text"
        inputMode={allowNegative ? "text" : "decimal"}
        value={value}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-lg border py-1.5 pl-5 pr-2 text-[12px] font-semibold tabular-nums text-gray-900 outline-none placeholder:font-normal placeholder:text-gray-300 ${
          invalid ? "border-amber-400 bg-amber-50/40" : "border-gray-200 bg-white"
        }`}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = accent;
          e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}22`;
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "";
          e.currentTarget.style.boxShadow = "";
        }}
      />
    </div>
  </div>
);

/** A compact text field for the File details block. */
const SmallText: React.FC<{
  label: string;
  value: string;
  accent: string;
  placeholder?: string;
  onChange: (value: string) => void;
}> = ({ label, value, accent, placeholder, onChange }) => (
  <div className="flex flex-col gap-1">
    <label className="text-[11px] font-semibold text-gray-600">{label}</label>
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] text-gray-900 outline-none placeholder:text-gray-300"
      onFocus={(e) => {
        e.currentTarget.style.borderColor = accent;
        e.currentTarget.style.boxShadow = `0 0 0 3px ${accent}22`;
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = "";
        e.currentTarget.style.boxShadow = "";
      }}
    />
  </div>
);

export default ClosingCostCalculator;
