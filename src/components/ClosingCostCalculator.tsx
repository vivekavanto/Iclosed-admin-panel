"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
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

type ConfigRow = Record<string, unknown>;

/** The `{ success, error }` envelope every route on this page answers with. */
interface ApiJson {
  success?: boolean;
  error?: string;
  data?: { updated_at?: string | null } | null;
  pdf_error?: string | null;
  pdf_attached?: boolean;
  sent_to?: string;
}

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
  /** null = never set; the calculation then falls back to its legacy default. */
  title_premium_is_estimate?: boolean | null;
  teraview_is_estimate?: boolean | null;
  sheriff_is_estimate?: boolean | null;
  property_tax_is_estimate?: boolean | null;
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
      // Long enough to read a full sentence — the blocked-action messages are
      // instructions, not confirmations, and a 3s flash is not enough to act on.
      setTimeout(() => setToast(null), 5000);
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

      const mortgageText = amountText(seed ? seed.mortgage_amount : prefill.mortgage_amount);

      // A saved estimate's own answer wins. NULL means it was saved before the
      // checkboxes existed (or by a caller that doesn't set them), so fall back
      // to what the calculation used to do on its own: the title premium is an
      // estimate until someone pastes the real quote, the other three always.
      const titleOverrideText = seed ? amountText(seed.title_premium_override) : "";
      const savedFlag = (v: boolean | null | undefined, fallback: boolean) =>
        v === null || v === undefined ? fallback : v === true;

      // The firm's planning figure for the Statement of Adjustments, from
      // Settings → Closing costs. It seeds a NEW estimate only: once an estimate
      // exists its own figure wins, including a deliberately-cleared one, so
      // raising the default never silently re-adds an adjustment a clerk removed.
      const adjustmentDefault = amountText(configRow?.property_tax_default);

      setForm({
        firmKey: seed?.firm_key || data.default_firm_key || "",
        statementType: seed?.statement_type || "draft",
        price: seed ? amountText(seed.purchase_price) : amountText(prefill.purchase_price),
        // A saved estimate's own figure always wins — including a deliberately
        // cleared one. Only a brand-new estimate takes the intake deposit.
        deposit: seed ? amountText(seed.deposit_paid) : amountText(prefill.deposit_paid),
        titlePremiumIsEstimate: savedFlag(
          seed?.title_premium_is_estimate,
          titleOverrideText === "",
        ),
        teraviewIsEstimate: savedFlag(seed?.teraview_is_estimate, true),
        sheriffIsEstimate: savedFlag(seed?.sheriff_is_estimate, true),
        propertyTaxIsEstimate: savedFlag(seed?.property_tax_is_estimate, true),
        mortgage: mortgageText,
        isToronto: seed ? Boolean(seed.is_toronto) : Boolean(prefill.is_toronto),
        isFirstTimeBuyer: seed
          ? Boolean(seed.is_first_time_buyer)
          : Boolean(prefill.is_first_time_buyer),
        // A saved estimate with no mortgage IS a cash deal — derive rather than
        // store, so the two can never disagree.
        isCashDeal:
          (Boolean(seed) || prefill.mortgage_amount === 0) &&
          (parseAmountInput(mortgageText) ?? 0) === 0,
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
      // Ticking "cash deal" zeroes the advance rather than clearing the field,
      // so unticking it restores whatever the clerk had typed.
      mortgage: form.isCashDeal ? 0 : (parseAmountInput(form.mortgage) ?? 0),
      isToronto: form.isToronto,
      isFirstTimeBuyer: form.isFirstTimeBuyer,
      titlePremiumOverride: parseAmountInput(form.titlePremiumOverride),
      provincialLttOverride: parseAmountInput(form.provincialLttOverride),
      municipalLttOverride: parseAmountInput(form.municipalLttOverride),
      propertyTaxAdjustment: parseAmountInput(form.propertyTaxAdjustment),
      // A final account states charges actually incurred, so nothing on it is
      // badged. The preview used to omit this and badged a final account that
      // the saved statement and the PDF did not — mirrors buildEstimateRow.
      isFinalAccount: form.statementType === "final",
      titlePremiumIsEstimate: form.titlePremiumIsEstimate,
      teraviewIsEstimate: form.teraviewIsEstimate,
      sheriffIsEstimate: form.sheriffIsEstimate,
      propertyTaxIsEstimate: form.propertyTaxIsEstimate,
    }),
    [form],
  );

  const statement = useMemo(() => computeStatement(inputs, rates), [inputs, rates]);

  /**
   * A response body that is not JSON is a route that crashed, not an answer.
   * Parsing it blind is what put `Unexpected token '<', "<!DOCTYPE "...` in the
   * toast in place of the reason — every caller below falls back to naming the
   * status instead.
   */
  const readJson = async (res: Response): Promise<ApiJson | null> => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

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
      title_premium_is_estimate: form.titlePremiumIsEstimate,
      teraview_is_estimate: form.teraviewIsEstimate,
      sheriff_is_estimate: form.sheriffIsEstimate,
      property_tax_is_estimate: form.propertyTaxIsEstimate,
      file_no_display: form.fileNo || null,
      purchasers: form.purchasers || null,
      property_address: form.propertyAddress || null,
      closing_date: form.closingDate || null,
      rate_overrides: rateOverrides,
    }),
    [inputs, form, rateOverrides],
  );

  // ───────────────────────────── actions ─────────────────────────────

  /**
   * Persist what is on screen as the working draft.
   *
   * No longer a button of its own — it is the first leg of "Save & issue", so a
   * failure at the issue step can never cost the clerk their typing. Returns
   * false when the write failed; the reason is already on screen as a toast.
   */
  const saveDraft = async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildBody(),
          expected_updated_at: draftUpdatedAtRef.current,
        }),
      });
      const data = await readJson(res);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Save failed (${res.status})`);
      }
      draftUpdatedAtRef.current = data.data?.updated_at ?? null;
      // Deliberately does NOT clear `dirty`. A saved draft is not an issued
      // estimate, and `dirty` is what gates the PDF and the email — clearing it
      // here would let a save that succeeded followed by an issue that failed
      // hand out the PREVIOUS issued PDF as if it matched the screen. Only the
      // reload after a successful issue clears it.
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
      return false;
    }
  };

  /**
   * Why the PDF and the email can't go out yet, in plain words — null when they
   * can.
   *
   * Both serve the ISSUED snapshot, never what is on screen, so both refuse for
   * exactly the same two reasons: nothing issued yet, or edits that have not
   * been issued. Saying so is the whole point — silently handing over a stale
   * PDF is how last week's figures reach a client's inbox.
   */
  const issuedBlocker = (action: string): string | null => {
    if (!issued) {
      return `Nothing has been issued yet — click "Save & issue to client" first, then ${action}.`;
    }
    if (dirty) {
      return `Your changes are not issued yet — click "Save & issue to client" first, then ${action}.`;
    }
    return null;
  };

  /**
   * Email the ISSUED estimate to the client.
   *
   * Deliberately refuses while there are un-issued edits: what the client would
   * receive is the frozen snapshot, not what is on screen, and sending a figure
   * the clerk can see they have just changed is how wrong numbers reach inboxes.
   */
  const handleEmail = async () => {
    // `!issued` is already covered by the blocker; repeated here so the
    // estimate_id below is a narrowed non-null rather than an assertion.
    const blocked = issuedBlocker("send the email");
    if (blocked || !issued) {
      showToast(blocked ?? "Nothing has been issued yet.", "error");
      return;
    }
    const to = emailTo.trim();
    if (!to) {
      showToast("Enter an email address to send to", "error");
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
      const data = await readJson(res);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Could not send the email (${res.status})`);
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

  /**
   * The page's one primary action: save what is on screen, then issue it.
   *
   * This used to be two buttons, and the pair invited exactly the mistake it
   * looked like it was preventing — a clerk saved a draft, read the "Issued"
   * chip still sitting beside it, and walked away believing the client had the
   * new figures. Both the PDF and the email serve the ISSUED snapshot, so the
   * client kept receiving the old ones. One button means what is on screen is
   * what the client gets.
   *
   * The save leg still runs first, so a rejected issue (bad price, a final
   * account missing its adjustment, a dropped connection) leaves the typing
   * safely on the draft row rather than only in the browser.
   */
  const handleSaveAndIssue = async () => {
    if (busy) return;
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
        "Save and issue this estimate to the client?\n\nThe figures and the rates behind them are frozen at this point, a PDF is generated, and the client can see it in their portal.",
      )
    ) {
      return;
    }

    setSaving(true);
    const saved = await saveDraft();
    setSaving(false);
    if (!saved) return;

    setIssuing(true);
    try {
      const res = await fetch(`/api/admin/deals/${dealId}/closing-estimate/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildBody()),
      });
      const data = await readJson(res);
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || `Could not issue the estimate (${res.status})`);
      }
      showToast(
        data.pdf_error
          ? "Saved and issued — the PDF will be generated on download"
          : "Saved and issued to the client",
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
   * Download the ISSUED statement.
   *
   * Refuses before there is one, and refuses while there are un-issued edits,
   * for the same reason the email does: the bytes come from the frozen
   * snapshot, so a download taken mid-edit is a document that does not match
   * the screen it was taken from.
   *
   * Fetched rather than opened as a plain link so a JSON error (rate limited,
   * generation failed) surfaces as a toast instead of dumping raw JSON into a
   * browser tab.
   */
  const handleDownload = async () => {
    const blocked = issuedBlocker("download the PDF");
    if (blocked) {
      showToast(blocked, "error");
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/admin/deals/${dealId}/closing-estimate/pdf`,
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

  /**
   * True while there is no issued snapshot matching the screen — so neither the
   * PDF nor the email has anything current to hand the client. Drives the muted
   * styling and the hint under those two buttons; `issuedBlocker` is what
   * actually refuses the click and says why.
   */
  const deliveryBlocked = !issued || dirty;

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

      {/* Admin chrome — the workflow actions that have no place on the client's
          statement, kept above the letterhead so the document below reads as the
          document.

          Sticky under AppHeader (h-14) so the one action, and the chips saying
          whether the client has these figures yet, stay in view down a long
          statement. The negative margins let the bar bleed to the edge of this
          page's gutter, so content scrolls under an opaque strip rather than
          past a floating island. */}
      <div className="sticky top-14 z-20 -mx-4 mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-slate-50/95 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
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
              Not issued yet
            </span>
          )}
          {/* One button, one meaning: the client ends up with what is on screen.
              A separate "Save draft" only ever produced files whose issued PDF
              disagreed with the page that had just been saved. */}
          <button
            type="button"
            onClick={handleSaveAndIssue}
            disabled={busy}
            title="Saves these figures and issues them to the client — the PDF and the email both use the issued version."
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: accent }}
          >
            {busy ? (
              <Loader2 size={13} className="animate-spin" />
            ) : issued && !dirty ? (
              <Send size={13} />
            ) : (
              <Save size={13} />
            )}
            {saving
              ? "Saving…"
              : issuing
                ? "Issuing…"
                : issued && !dirty
                  ? "Re-issue to client"
                  : "Save & issue to client"}
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
      <Letterhead
        config={activeConfig}
        fileNo={form.fileNo || deal?.file_number || ""}
      />

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
        {/* Sticks below BOTH the app header (h-14) and the action bar above, so
            the inputs never slide up underneath them. */}
        <section className="flex flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm lg:sticky lg:top-[120px]">
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

          {/* Both of these hand out the ISSUED statement. They stay CLICKABLE
              while there is nothing issued to hand out — a disabled pair would
              leave the clerk guessing, where a click gives them the sentence
              that says what to do. */}
          <div className="flex flex-col gap-2 pt-0.5">
            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                onClick={() => {
                  const blocked = issuedBlocker("email it");
                  if (blocked) {
                    showToast(blocked, "error");
                    setEmailOpen(false);
                    return;
                  }
                  setEmailOpen((o) => !o);
                }}
                className={`min-w-[150px] flex-1 rounded-xl border px-4 py-3 text-[13.5px] font-semibold transition ${
                  deliveryBlocked
                    ? "border-gray-200 bg-gray-50 text-gray-400"
                    : "border-gray-200 bg-white text-gray-800 hover:border-gray-300"
                }`}
              >
                <Mail size={14} className="mr-1.5 inline" />
                Email to client
              </button>
              <button
                type="button"
                onClick={handleDownload}
                disabled={downloading}
                className={`inline-flex min-w-[150px] flex-1 items-center justify-center gap-1.5 rounded-xl px-4 py-3 text-[13.5px] font-semibold transition disabled:opacity-50 ${
                  deliveryBlocked ? "bg-gray-200 text-gray-500" : "text-white"
                }`}
                style={deliveryBlocked ? undefined : { backgroundColor: accent }}
              >
                {downloading ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                Download PDF
              </button>
            </div>
            {deliveryBlocked && (
              <span className="text-[11px] leading-snug text-amber-700">
                {issued
                  ? "You have changed the numbers. Click “Save & issue to client” above before you download or email — both send the issued version, not what is on screen."
                  : "Click “Save & issue to client” above first. The PDF and the email both send the issued version, so there is nothing to send until then."}
              </span>
            )}
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
                Change a number and you will need to save &amp; issue again first.
              </span>
            </div>
          )}
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

export default ClosingCostCalculator;
