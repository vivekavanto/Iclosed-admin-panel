"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import ClosingCostFirmCard from "./ClosingCostFirmCard";
import ClosingCostSharedRatesCard from "./ClosingCostSharedRatesCard";
import ClosingCostStatementTypesCard from "./ClosingCostStatementTypesCard";
import {
  DEFAULT_LTT_TIERS,
  DEFAULT_MLTT_TIERS,
  computeStatement,
  ratesFromConfigRow,
  type Tier,
} from "@/lib/closingCosts";
import {
  FIRM_KEYS,
  STATEMENT_TYPE_KEYS,
  type FirmKey,
  type StatementTypeKey,
} from "@/lib/closingCostSettings";
import {
  BRAND,
  FIRM_NUMERIC_FIELDS,
  LETTERHEAD_FIELDS,
  SHARED_NUMERIC_FIELDS,
  STATEMENT_TEXT_FIELDS,
  draftToNumericBody,
  rowToDraft,
  type Draft,
} from "@/lib/closingCostSettingsFields";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";

// Closing-cost settings — firm profiles, the shared statutory rates and the
// statement-type wording behind every purchase closing-cost estimate.
//
// Editing here changes what FUTURE estimates are calculated with. Estimates
// already issued keep their own frozen snapshot and are never rewritten, which
// is why this page can be edited freely without auditing every open file.
//
// Three independent Saves rather than one, because the blast radii differ: a
// shared-rate change alters what BOTH firms quote, while a firm's fee change
// affects only its own files.

type Section = "firms" | "shared" | "statements";

interface Bundle {
  schema_ready: boolean;
  firms: Record<string, unknown>[];
  shared: Record<string, unknown>;
  statement_types: Record<string, unknown>[];
  is_default: { firms: boolean; shared: boolean; statement_types: boolean };
}

const LETTERHEAD_KEYS = LETTERHEAD_FIELDS.map((f) => f.key);
const STATEMENT_TEXT_KEYS = ["label", ...STATEMENT_TEXT_FIELDS.map((f) => f.key)];

const TABS: Array<{ id: Section; label: string }> = [
  { id: "firms", label: "Firms" },
  { id: "shared", label: "Shared rates" },
  { id: "statements", label: "Statement types" },
];

function firmRowToDraft(row: Record<string, unknown>): Draft {
  return {
    ...rowToDraft(row, FIRM_NUMERIC_FIELDS, [...LETTERHEAD_KEYS, "brand_color", "label"]),
  };
}

function sharedRowToDraft(row: Record<string, unknown>): Draft {
  return rowToDraft(row, SHARED_NUMERIC_FIELDS, [
    "default_firm_key",
    "default_statement_type",
  ]);
}

function statementRowToDraft(row: Record<string, unknown>): Draft {
  const draft = rowToDraft(row, [], [...STATEMENT_TEXT_KEYS, "watermark_text"]);
  // Checkboxes ride in the same string-keyed draft as everything else.
  draft.show_watermark = row.show_watermark === true ? "true" : "false";
  return draft;
}

function tiersOf(value: unknown, fallback: Tier[]): Tier[] {
  return Array.isArray(value) && value.length > 0 ? (value as Tier[]) : fallback;
}

const ClosingCostSettings: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(
    null,
  );

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [tab, setTab] = useState<Section>("firms");
  const [activeFirm, setActiveFirm] = useState<FirmKey>(FIRM_KEYS[0]);
  const [activeType, setActiveType] = useState<StatementTypeKey>(STATEMENT_TYPE_KEYS[0]);
  const [saving, setSaving] = useState<string | null>(null);

  // Drafts are keyed so switching a tab never discards unsaved edits.
  const [firmDrafts, setFirmDrafts] = useState<Record<string, Draft>>({});
  const [firmActive, setFirmActive] = useState<Record<string, boolean>>({});
  // Held apart from the drafts: the logo is written by its own upload route, so
  // it must never ride along in the Save payload or be reverted by a discard.
  const [firmLogos, setFirmLogos] = useState<Record<string, string>>({});
  const [sharedDraft, setSharedDraft] = useState<Draft>({});
  const [statementDrafts, setStatementDrafts] = useState<Record<string, Draft>>({});
  const [lttTiers, setLttTiers] = useState<Tier[]>(DEFAULT_LTT_TIERS);
  const [mlttTiers, setMlttTiers] = useState<Tier[]>(DEFAULT_MLTT_TIERS);
  const [dirty, setDirty] = useState<Record<string, boolean>>({});

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const hydrate = useCallback((data: Bundle) => {
    setBundle(data);

    const firms: Record<string, Draft> = {};
    const active: Record<string, boolean> = {};
    const logos: Record<string, string> = {};
    for (const row of data.firms ?? []) {
      const key = String(row.firm_key ?? "");
      if (!key) continue;
      firms[key] = firmRowToDraft(row);
      active[key] = row.is_active === true;
      logos[key] = String(row.logo_url ?? "");
    }
    setFirmDrafts(firms);
    setFirmActive(active);
    setFirmLogos(logos);

    setSharedDraft(sharedRowToDraft(data.shared ?? {}));
    setLttTiers(tiersOf(data.shared?.ltt_tiers, DEFAULT_LTT_TIERS));
    setMlttTiers(tiersOf(data.shared?.mltt_tiers, DEFAULT_MLTT_TIERS));

    const statements: Record<string, Draft> = {};
    for (const row of data.statement_types ?? []) {
      const key = String(row.type_key ?? "");
      if (key) statements[key] = statementRowToDraft(row);
    }
    setStatementDrafts(statements);
    setDirty({});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/closing-cost-config");
      const data = await res.json();
      if (!res.ok || !data?.success) {
        throw new Error(data?.error || "Could not load the configuration");
      }
      hydrate(data as Bundle);
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Could not load the configuration",
      );
    } finally {
      setLoading(false);
    }
  }, [hydrate]);

  useEffect(() => {
    void load();
  }, [load]);

  const locked = bundle ? !bundle.schema_ready : false;

  // ── edit handlers ───────────────────────────────────────────────────
  const markDirty = (key: string) => setDirty((prev) => ({ ...prev, [key]: true }));

  const editFirm = (firmKey: string) => (key: string, value: string) => {
    setFirmDrafts((prev) => ({
      ...prev,
      [firmKey]: { ...(prev[firmKey] ?? {}), [key]: value },
    }));
    markDirty(`firm:${firmKey}`);
  };

  const editShared = (key: string, value: string) => {
    setSharedDraft((prev) => ({ ...prev, [key]: value }));
    markDirty("shared");
  };

  const editStatement = (typeKey: string) => (key: string, value: string) => {
    setStatementDrafts((prev) => ({
      ...prev,
      [typeKey]: { ...(prev[typeKey] ?? {}), [key]: value },
    }));
    markDirty(`statement:${typeKey}`);
  };

  // ── live sample ─────────────────────────────────────────────────────
  /** The reference file from the requirements document, priced with the firm on screen. */
  const preview = useMemo(() => {
    const row: Record<string, unknown> = {};
    const firmDraft = firmDrafts[activeFirm] ?? {};

    for (const field of SHARED_NUMERIC_FIELDS) {
      const parsed = parseAmountInput(sharedDraft[field.key] ?? "");
      if (parsed === null) continue;
      row[field.key] = field.asPercent ? parsed / 100 : parsed;
    }
    for (const field of FIRM_NUMERIC_FIELDS) {
      const parsed = parseAmountInput(firmDraft[field.key] ?? "");
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
  }, [sharedDraft, firmDrafts, activeFirm, lttTiers, mlttTiers]);

  // ── saves ───────────────────────────────────────────────────────────
  async function put(url: string, body: Record<string, unknown>, savingKey: string) {
    setSaving(savingKey);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "Save failed");
      await load();
      showToast("Saved");
      return true;
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Save failed", "error");
      return false;
    } finally {
      setSaving(null);
    }
  }

  const saveFirm = async (firmKey: string) => {
    const draft = firmDrafts[firmKey] ?? {};
    const { error, body } = draftToNumericBody(
      draft,
      FIRM_NUMERIC_FIELDS,
      parseAmountInput,
    );
    if (error) return showToast(error, "error");

    for (const field of LETTERHEAD_FIELDS) {
      const value = (draft[field.key] ?? "").trim();
      if (!value) return showToast(`${field.label} cannot be empty`, "error");
      body[field.key] = value;
    }
    const label = (draft.label ?? "").trim();
    if (!label) return showToast("The firm label cannot be empty", "error");
    body.label = label;

    const color = (draft.brand_color ?? "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      return showToast("Brand colour must be a 6-digit hex such as #C10007", "error");
    }
    body.brand_color = color;
    body.is_active = firmActive[firmKey] === true;

    await put(
      `/api/admin/closing-cost-config/firms/${firmKey}`,
      body,
      `firm:${firmKey}`,
    );
  };

  const saveShared = async () => {
    const { error, body } = draftToNumericBody(
      sharedDraft,
      SHARED_NUMERIC_FIELDS,
      parseAmountInput,
    );
    if (error) return showToast(error, "error");

    for (const [tiers, label] of [
      [lttTiers, "Ontario LTT brackets"],
      [mlttTiers, "Toronto MLTT brackets"],
    ] as Array<[Tier[], string]>) {
      if (tiers[tiers.length - 1]?.[0] !== null) {
        return showToast(`${label}: the last band must be open-ended`, "error");
      }
    }
    body.ltt_tiers = lttTiers;
    body.mltt_tiers = mlttTiers;
    body.default_firm_key = sharedDraft.default_firm_key;
    body.default_statement_type = sharedDraft.default_statement_type;

    await put("/api/admin/closing-cost-config/shared", body, "shared");
  };

  /**
   * The logo is uploaded immediately rather than joining the Save payload: it
   * is multipart, it replaces a blob server-side, and batching it into a JSON
   * PUT would mean a failed image silently rolling back a fee change too.
   */
  const uploadLogo = async (firmKey: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    try {
      const res = await fetch(
        `/api/admin/closing-cost-config/firms/${firmKey}/logo`,
        { method: "POST", body },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "Upload failed");
      await load();
      showToast("Logo updated");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed", "error");
    }
  };

  const removeLogo = async (firmKey: string) => {
    try {
      const res = await fetch(
        `/api/admin/closing-cost-config/firms/${firmKey}/logo`,
        { method: "DELETE" },
      );
      const data = await res.json();
      if (!res.ok || !data?.success) throw new Error(data?.error || "Could not remove");
      await load();
      showToast("Logo removed");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not remove", "error");
    }
  };

  const saveStatementType = async (typeKey: string) => {
    const draft = statementDrafts[typeKey] ?? {};
    const body: Record<string, unknown> = {};
    for (const key of [...STATEMENT_TEXT_KEYS, "watermark_text"]) {
      body[key] = (draft[key] ?? "").trim();
    }
    // Only the footer note may legitimately be blank.
    for (const key of [...STATEMENT_TEXT_KEYS, "watermark_text"]) {
      if (key !== "footer_note" && !body[key]) {
        return showToast(`${key.replace(/_/g, " ")} cannot be empty`, "error");
      }
    }
    body.show_watermark = draft.show_watermark === "true";

    await put(
      `/api/admin/closing-cost-config/statement-types/${typeKey}`,
      body,
      `statement:${typeKey}`,
    );
  };

  // ── render ──────────────────────────────────────────────────────────
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

  const firmOptions = FIRM_KEYS.map((key) => ({
    key,
    label: firmDrafts[key]?.label || key,
    isActive: firmActive[key] === true,
  }));

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

      <div className="mb-5">
        <h1 className="text-xl font-bold text-gray-900">Closing cost settings</h1>
        <p className="mt-1 max-w-2xl text-xs text-gray-500">
          The firm profiles, statutory rates and statement wording behind every purchase
          closing-cost estimate. Changing them affects new estimates only — an estimate
          already issued keeps the figures the client was sent.
        </p>
      </div>

      {locked && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            The firm and statement-type tables do not exist yet. Run the
            <code className="mx-1 rounded bg-red-100 px-1">
              2026-08-03-closing-cost-firms-and-statement-types
            </code>
            migration in the Supabase SQL editor and reload — saving is disabled until
            then. Existing estimates and PDFs are unaffected.
          </span>
        </div>
      )}

      {!locked && bundle?.is_default.firms && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            No firm rows exist yet — these are the built-in defaults. Save each firm once
            to store them.
          </span>
        </div>
      )}

      <div className="mb-5 flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className="relative px-4 py-2.5 text-xs font-semibold transition-colors"
            style={{ color: tab === t.id ? BRAND : "#6b7280" }}
          >
            {t.label}
            {tab === t.id && (
              <span
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full"
                style={{ backgroundColor: BRAND }}
              />
            )}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,300px)]">
        <div>
          {tab === "firms" && (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                {firmOptions.map((firm) => (
                  <button
                    key={firm.key}
                    type="button"
                    onClick={() => setActiveFirm(firm.key)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold ${
                      activeFirm === firm.key
                        ? "border-transparent text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                    style={
                      activeFirm === firm.key ? { backgroundColor: BRAND } : undefined
                    }
                  >
                    {firm.label}
                    {dirty[`firm:${firm.key}`] && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    )}
                    {!firm.isActive && (
                      <span className="text-[10px] font-normal opacity-70">inactive</span>
                    )}
                  </button>
                ))}
              </div>

              <ClosingCostFirmCard
                label={firmDrafts[activeFirm]?.label || activeFirm}
                draft={firmDrafts[activeFirm] ?? {}}
                logoUrl={firmLogos[activeFirm] ?? ""}
                onLogoUpload={(file) => uploadLogo(activeFirm, file)}
                onLogoRemove={() => removeLogo(activeFirm)}
                isActive={firmActive[activeFirm] === true}
                isDivision={activeFirm !== FIRM_KEYS[0]}
                dirty={Boolean(dirty[`firm:${activeFirm}`])}
                saving={saving === `firm:${activeFirm}`}
                disabled={locked}
                onChange={editFirm(activeFirm)}
                onToggleActive={(next) => {
                  setFirmActive((prev) => ({ ...prev, [activeFirm]: next }));
                  markDirty(`firm:${activeFirm}`);
                }}
                onSave={() => void saveFirm(activeFirm)}
              />
            </div>
          )}

          {tab === "shared" && (
            <ClosingCostSharedRatesCard
              draft={sharedDraft}
              lttTiers={lttTiers}
              mlttTiers={mlttTiers}
              firmOptions={firmOptions}
              dirty={Boolean(dirty.shared)}
              saving={saving === "shared"}
              disabled={locked}
              onChange={editShared}
              onLttChange={(t) => {
                setLttTiers(t);
                markDirty("shared");
              }}
              onMlttChange={(t) => {
                setMlttTiers(t);
                markDirty("shared");
              }}
              onSave={() => void saveShared()}
            />
          )}

          {tab === "statements" && (
            <div className="space-y-5">
              <div className="flex flex-wrap gap-2">
                {STATEMENT_TYPE_KEYS.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setActiveType(key)}
                    className={`inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-semibold ${
                      activeType === key
                        ? "border-transparent text-white"
                        : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                    }`}
                    style={activeType === key ? { backgroundColor: BRAND } : undefined}
                  >
                    {statementDrafts[key]?.label || key}
                    {dirty[`statement:${key}`] && (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                    )}
                  </button>
                ))}
              </div>

              <ClosingCostStatementTypesCard
                typeKey={activeType}
                label={statementDrafts[activeType]?.label || activeType}
                draft={statementDrafts[activeType] ?? {}}
                dirty={Boolean(dirty[`statement:${activeType}`])}
                saving={saving === `statement:${activeType}`}
                disabled={locked}
                onChange={editStatement(activeType)}
                onToggleWatermark={(next) =>
                  editStatement(activeType)("show_watermark", next ? "true" : "false")
                }
                onSave={() => void saveStatementType(activeType)}
              />
            </div>
          )}
        </div>

        {/* Live sample — the reference file from the requirements document, so a
            change to any fee shows up immediately in a familiar total. Priced
            with the firm currently on screen, so switching tabs shows the
            difference between the two fee schedules. */}
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
              SAMPLE ESTIMATE
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
              A $1,080,000 purchase outside Toronto, $50,000 deposit, $399,700 mortgage,
              not a first-time buyer — priced as{" "}
              <strong>{firmDrafts[activeFirm]?.label || activeFirm}</strong>.
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

export default ClosingCostSettings;
