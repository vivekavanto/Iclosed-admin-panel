"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RotateCcw, Save, TriangleAlert, X } from "lucide-react";
import {
  DEFAULT_LTT_TIERS,
  DEFAULT_MLTT_TIERS,
  computeStatement,
  ratesFromConfigRow,
  type Tier,
} from "@/lib/closingCosts";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";

// Firm-standard closing-cost fees, rates, land-transfer-tax brackets and PDF
// letterhead — the single active `closing_cost_config` row.
//
// Editing here changes what FUTURE estimates are calculated with. Estimates
// already issued keep their own frozen snapshot and are never rewritten, which
// is why this page can be edited freely without auditing every open file.

const BRAND = "#C10007";

const inputClass =
  "w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

type Draft = Record<string, string>;

interface NumericField {
  key: string;
  label: string;
  hint?: string;
  prefix?: "$" | "%";
  /** Stored as a rate (0.13) but edited as a percentage (13). */
  asPercent?: boolean;
  /** Edited at full precision — a rate like 0.000785. */
  raw?: boolean;
}

const SECTIONS: Array<{ title: string; note?: string; fields: NumericField[] }> = [
  {
    title: "Third-Party Disbursements",
    note: "Government and search costs the firm pays on the client's behalf. The mortgage registration only applies when there is a mortgage.",
    fields: [
      { key: "reg_transfer", label: "Registration of Transfer", prefix: "$" },
      { key: "reg_mortgage", label: "Registration of Mortgage", prefix: "$" },
      { key: "teraview", label: "Teraview — searches & review", prefix: "$" },
      { key: "sheriff", label: "Sheriff's Certificates", prefix: "$" },
    ],
  },
  {
    title: "Legal & Admin Fees",
    note: "The client sees one combined \"Legal fees\" line — transfer + mortgage + title submission. A cash purchase drops the mortgage portion.",
    fields: [
      { key: "legal_transfer", label: "Legal fee — transfer", prefix: "$" },
      { key: "legal_mortgage", label: "Legal fee — mortgage", prefix: "$" },
      { key: "legal_title_submission", label: "Legal — title submission", prefix: "$" },
      { key: "admin_fee", label: "Admin fee", prefix: "$" },
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
        raw: true,
      },
      { key: "title_premium_min", label: "Minimum premium", prefix: "$" },
    ],
  },
];

const LETTERHEAD_FIELDS: Array<{ key: string; label: string; wide?: boolean }> = [
  { key: "firm_name", label: "Firm name", wide: true },
  { key: "firm_subtitle", label: "Subtitle" },
  { key: "firm_hst_number", label: "HST number" },
  { key: "firm_address", label: "Address", wide: true },
  { key: "firm_phone", label: "Telephone" },
  { key: "firm_fax", label: "Fax" },
];

const ALL_NUMERIC = SECTIONS.flatMap((s) => s.fields);

/** DB row → editable text draft. */
function rowToDraft(row: Record<string, unknown>): Draft {
  const draft: Draft = {};
  for (const field of ALL_NUMERIC) {
    const n = Number(row[field.key] ?? 0);
    if (!Number.isFinite(n)) {
      draft[field.key] = "";
      continue;
    }
    draft[field.key] = field.asPercent ? String(Number((n * 100).toFixed(6))) : String(n);
  }
  for (const field of LETTERHEAD_FIELDS) {
    draft[field.key] = String(row[field.key] ?? "");
  }
  return draft;
}

function rowToTiers(value: unknown, fallback: Tier[]): Tier[] {
  return Array.isArray(value) && value.length > 0 ? (value as Tier[]) : fallback;
}

/** "$0 – $55,000" / "$2,000,000 and above" */
function bandLabel(prevCap: number, cap: number | null): string {
  const from = formatCurrency(prevCap, { cents: false });
  if (cap === null) return `${from} and above`;
  return `${from} – ${formatCurrency(cap, { cents: false })}`;
}

const ClosingCostSettings: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(
    null,
  );
  const [isDefault, setIsDefault] = useState(false);

  const [draft, setDraft] = useState<Draft>({});
  const [lttTiers, setLttTiers] = useState<Tier[]>(DEFAULT_LTT_TIERS);
  const [mlttTiers, setMlttTiers] = useState<Tier[]>(DEFAULT_MLTT_TIERS);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/closing-cost-config");
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load the configuration");
      }
      setDraft(rowToDraft(data.data ?? {}));
      setLttTiers(rowToTiers(data.data?.ltt_tiers, DEFAULT_LTT_TIERS));
      setMlttTiers(rowToTiers(data.data?.mltt_tiers, DEFAULT_MLTT_TIERS));
      setIsDefault(Boolean(data.is_default));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load the configuration",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Live sample so a fee edit's effect is visible before saving. */
  const preview = useMemo(() => {
    const row: Record<string, unknown> = {};
    for (const field of ALL_NUMERIC) {
      const parsed = parseAmountInput(draft[field.key] ?? "");
      if (parsed === null) continue;
      row[field.key] = field.asPercent ? parsed / 100 : parsed;
    }
    row.ltt_tiers = lttTiers;
    row.mltt_tiers = mlttTiers;
    return computeStatement(
      {
        price: 1_080_000,
        deposit: 50_000,
        mortgage: 399_700,
        isToronto: false,
        isFirstTimeBuyer: false,
      },
      ratesFromConfigRow(row),
    );
  }, [draft, lttTiers, mlttTiers]);

  const handleSave = async () => {
    // Validate locally first so a typo doesn't need a round trip.
    const body: Record<string, unknown> = {};
    for (const field of ALL_NUMERIC) {
      const parsed = parseAmountInput(draft[field.key] ?? "");
      if (parsed === null) {
        showToast(`${field.label} must be a number`, "error");
        return;
      }
      if (parsed < 0) {
        showToast(`${field.label} cannot be negative`, "error");
        return;
      }
      body[field.key] = field.asPercent ? parsed / 100 : parsed;
    }
    for (const field of LETTERHEAD_FIELDS) {
      const value = (draft[field.key] ?? "").trim();
      if (!value) {
        showToast(`${field.label} cannot be empty`, "error");
        return;
      }
      body[field.key] = value;
    }
    for (const [tiers, label] of [
      [lttTiers, "Ontario LTT brackets"],
      [mlttTiers, "Toronto MLTT brackets"],
    ] as Array<[Tier[], string]>) {
      if (tiers[tiers.length - 1]?.[0] !== null) {
        showToast(`${label}: the last band must be open-ended`, "error");
        return;
      }
    }
    body.ltt_tiers = lttTiers;
    body.mltt_tiers = mlttTiers;

    setSaving(true);
    try {
      const res = await fetch("/api/admin/closing-cost-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Save failed");
      }
      setDraft(rowToDraft(data.data ?? {}));
      setLttTiers(rowToTiers(data.data?.ltt_tiers, DEFAULT_LTT_TIERS));
      setMlttTiers(rowToTiers(data.data?.mltt_tiers, DEFAULT_MLTT_TIERS));
      setIsDefault(false);
      showToast("Closing cost configuration saved");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" /> Loading configuration…
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
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
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

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Closing cost settings</h1>
          <p className="mt-1 max-w-2xl text-xs text-gray-500">
            The firm-standard fees and rates behind every purchase closing-cost estimate.
            Changing them affects new estimates only — an estimate already issued keeps the
            figures the client was sent.
          </p>
        </div>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
          style={{ backgroundColor: BRAND }}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          Save configuration
        </button>
      </div>

      {isDefault && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            No configuration row exists yet — these are the built-in defaults. Save once to
            store them. (If you expected a saved row, check that the
            <code className="mx-1 rounded bg-amber-100 px-1">
              2026-07-30-closing-cost-calculator
            </code>
            migration has been run.)
          </span>
        </div>
      )}

      <div className="mb-5 flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-gray-400" />
        <span>
          Statutory rates change. Confirm the Ontario LTT brackets, the Toronto MLTT
          brackets (including the tiers above $2M) and both rebate maximums against the
          Ontario Ministry of Finance and the City of Toronto before relying on them.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div className="space-y-5">
          {SECTIONS.map((section) => (
            <section
              key={section.title}
              className="rounded-xl border border-gray-200 bg-white p-5"
            >
              <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
                {section.title.toUpperCase()}
              </h2>
              {section.note && (
                <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
                  {section.note}
                </p>
              )}
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-[12px] font-semibold text-gray-800">
                      {field.label}
                      {field.hint && (
                        <span className="ml-1 font-normal text-gray-400">
                          — {field.hint}
                        </span>
                      )}
                    </label>
                    <div className="relative mt-1.5">
                      {field.prefix && (
                        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">
                          {field.prefix}
                        </span>
                      )}
                      <input
                        type="text"
                        inputMode="decimal"
                        value={draft[field.key] ?? ""}
                        onChange={(e) =>
                          setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
                        }
                        className={`${inputClass} tabular-nums ${field.prefix ? "pl-7" : ""}`}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}

          <TierEditor
            title="Ontario LTT Brackets"
            note="Marginal bands — each rate applies only to the portion of the price inside that band. The last band must be open-ended."
            tiers={lttTiers}
            onChange={setLttTiers}
            onReset={() => setLttTiers(DEFAULT_LTT_TIERS)}
          />

          <TierEditor
            title="Toronto MLTT Brackets"
            note="Applied in addition to the provincial tax when the property is in the City of Toronto."
            tiers={mlttTiers}
            onChange={setMlttTiers}
            onReset={() => setMlttTiers(DEFAULT_MLTT_TIERS)}
          />

          <section className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              PDF LETTERHEAD
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              Printed at the top of every generated estimate PDF.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              {LETTERHEAD_FIELDS.map((field) => (
                <div key={field.key} className={field.wide ? "sm:col-span-2" : undefined}>
                  <label className="block text-[12px] font-semibold text-gray-800">
                    {field.label}
                  </label>
                  <input
                    type="text"
                    value={draft[field.key] ?? ""}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, [field.key]: e.target.value }))
                    }
                    className={`${inputClass} mt-1.5`}
                  />
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Live sample — the reference file from the requirements document, so a
            change to any fee shows up immediately in a familiar total. */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              SAMPLE ESTIMATE
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              A $1,080,000 purchase outside Toronto, $50,000 deposit, $399,700 mortgage, not
              a first-time buyer.
            </p>
            <dl className="mt-4 space-y-2 text-[12px]">
              {[
                ["Ontario land transfer tax", preview.detail.provincialLTT],
                ["Title insurance premium", preview.detail.titlePremium],
                ["Legal fees", preview.detail.legalFees],
                ["HST", preview.hst.amount],
              ].map(([label, value]) => (
                <div key={String(label)} className="flex justify-between gap-3">
                  <dt className="text-gray-500">{label}</dt>
                  <dd className="tabular-nums text-gray-800">
                    {formatCurrency(Number(value))}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-gray-100 pt-2 font-bold">
                <dt style={{ color: BRAND }}>Total closing costs</dt>
                <dd className="tabular-nums" style={{ color: BRAND }}>
                  {formatCurrency(preview.total)}
                </dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-gray-500">Balance due on closing</dt>
                <dd className="tabular-nums text-gray-800">
                  {formatCurrency(preview.balance.balanceDue)}
                </dd>
              </div>
            </dl>
          </div>
        </aside>
      </div>
    </div>
  );
};

/** Add/remove/edit rows of a marginal bracket table. */
const TierEditor: React.FC<{
  title: string;
  note: string;
  tiers: Tier[];
  onChange: (tiers: Tier[]) => void;
  onReset: () => void;
}> = ({ title, note, tiers, onChange, onReset }) => {
  const setCap = (index: number, raw: string) => {
    const next = tiers.map((t) => [...t] as Tier);
    const parsed = parseAmountInput(raw);
    next[index][0] = parsed;
    onChange(next);
  };

  const setRate = (index: number, raw: string) => {
    const next = tiers.map((t) => [...t] as Tier);
    const parsed = parseAmountInput(raw);
    next[index][1] = parsed === null ? 0 : parsed / 100;
    onChange(next);
  };

  const addBand = () => {
    // Insert above the open-ended band so it always stays last.
    const next = tiers.map((t) => [...t] as Tier);
    const lastCapped = next.length >= 2 ? next[next.length - 2][0] : null;
    const suggestedCap = typeof lastCapped === "number" ? lastCapped * 2 : 100_000;
    next.splice(next.length - 1, 0, [suggestedCap, next[next.length - 1][1]]);
    onChange(next);
  };

  const removeBand = (index: number) => {
    if (tiers.length <= 1) return;
    onChange(tiers.filter((_, i) => i !== index));
  };

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
            {title.toUpperCase()}
          </h2>
          <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-gray-400">{note}</p>
        </div>
        <button
          type="button"
          onClick={onReset}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
        >
          <RotateCcw size={12} /> Reset
        </button>
      </div>

      <div className="mt-4 space-y-2">
        <div className="grid grid-cols-[1fr_120px_110px_32px] gap-2 px-1 text-[10px] font-bold tracking-wide text-gray-400">
          <span>PORTION OF PRICE</span>
          <span>UP TO</span>
          <span>RATE</span>
          <span />
        </div>
        {tiers.map((tier, index) => {
          const prevCap = index === 0 ? 0 : (tiers[index - 1][0] ?? 0);
          const isLast = index === tiers.length - 1;
          return (
            <div
              key={index}
              className="grid grid-cols-[1fr_120px_110px_32px] items-center gap-2"
            >
              <span className="text-[12px] text-gray-600 tabular-nums">
                {bandLabel(prevCap, tier[0])}
              </span>
              {isLast ? (
                <span className="px-2 text-[11px] italic text-gray-400">and above</span>
              ) : (
                <input
                  type="text"
                  inputMode="decimal"
                  value={tier[0] === null ? "" : String(tier[0])}
                  onChange={(e) => setCap(index, e.target.value)}
                  className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[12px] tabular-nums focus:border-[#C10007] focus:outline-none focus:ring-1 focus:ring-[#C10007]"
                />
              )}
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  value={String(Number((tier[1] * 100).toFixed(6)))}
                  onChange={(e) => setRate(index, e.target.value)}
                  className="w-full rounded-md border border-gray-200 pl-2 pr-5 py-1.5 text-[12px] tabular-nums focus:border-[#C10007] focus:outline-none focus:ring-1 focus:ring-[#C10007]"
                />
                <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-gray-400">
                  %
                </span>
              </div>
              {isLast ? (
                <span />
              ) : (
                <button
                  type="button"
                  onClick={() => removeBand(index)}
                  aria-label="Remove band"
                  className="justify-self-center text-gray-300 hover:text-red-600"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addBand}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
      >
        <Plus size={12} /> Add band
      </button>
    </section>
  );
};

export default ClosingCostSettings;
