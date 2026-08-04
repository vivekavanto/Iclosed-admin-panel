"use client";

import React from "react";
import { Loader2, Save, TriangleAlert } from "lucide-react";
import ClosingCostFieldSection from "./ClosingCostFieldSection";
import ClosingCostTierEditor from "./ClosingCostTierEditor";
import { DEFAULT_LTT_TIERS, DEFAULT_MLTT_TIERS, type Tier } from "@/lib/closingCosts";
import {
  BRAND,
  SHARED_SECTIONS,
  inputClass,
  type Draft,
} from "@/lib/closingCostSettingsFields";

// Statutory & third-party values — edited ONCE and applied to every firm.
//
// These are the costs no firm supplies (and so none carries HST): the
// e-registration tariff, land transfer tax, the first-time-buyer rebates and
// FCT's premium formula. Holding them in one row is what stops a bracket change
// from being applied to one firm and forgotten on the other.

const ClosingCostSharedRatesCard: React.FC<{
  draft: Draft;
  lttTiers: Tier[];
  mlttTiers: Tier[];
  firmOptions: Array<{ key: string; label: string; isActive: boolean }>;
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  onChange: (key: string, value: string) => void;
  onLttChange: (tiers: Tier[]) => void;
  onMlttChange: (tiers: Tier[]) => void;
  onSave: () => void;
}> = ({
  draft,
  lttTiers,
  mlttTiers,
  firmOptions,
  dirty,
  saving,
  disabled,
  onChange,
  onLttChange,
  onMlttChange,
  onSave,
}) => (
  <div className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div>
        <h2 className="text-sm font-bold text-gray-900">Statutory &amp; third-party</h2>
        <p className="mt-0.5 text-[11px] text-gray-400">
          Edited once — applies to <strong>every</strong> firm.
        </p>
      </div>
      <button
        type="button"
        onClick={onSave}
        disabled={disabled || saving || !dirty}
        className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
        style={{ backgroundColor: BRAND }}
      >
        {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
        Save shared rates
      </button>
    </div>

    <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-gray-600">
      <TriangleAlert size={14} className="mt-0.5 shrink-0 text-gray-400" />
      <span>
        Statutory rates change. Confirm the Ontario LTT brackets, the Toronto MLTT
        brackets (including the tiers above $2M) and both rebate maximums against the
        Ontario Ministry of Finance and the City of Toronto before relying on them.
      </span>
    </div>

    {SHARED_SECTIONS.map((section) => (
      <ClosingCostFieldSection
        key={section.title}
        section={section}
        draft={draft}
        disabled={disabled || saving}
        onChange={onChange}
      />
    ))}

    <ClosingCostTierEditor
      title="Ontario LTT Brackets"
      note="Marginal bands — each rate applies only to the portion of the price inside that band. The last band must be open-ended."
      tiers={lttTiers}
      disabled={disabled || saving}
      onChange={onLttChange}
      onReset={() => onLttChange(DEFAULT_LTT_TIERS)}
    />

    <ClosingCostTierEditor
      title="Toronto MLTT Brackets"
      note="Applied in addition to the provincial tax when the property is in the City of Toronto."
      tiers={mlttTiers}
      disabled={disabled || saving}
      onChange={onMlttChange}
      onReset={() => onMlttChange(DEFAULT_MLTT_TIERS)}
    />

    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
        DEFAULTS
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
        Used for every estimate until the per-deal firm and statement-type picker ships.
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-[12px] font-semibold text-gray-800">
            Default firm
          </label>
          <select
            disabled={disabled || saving}
            value={draft.default_firm_key ?? ""}
            onChange={(e) => onChange("default_firm_key", e.target.value)}
            className={`${inputClass} mt-1.5 disabled:bg-gray-50`}
          >
            {firmOptions.map((firm) => (
              <option key={firm.key} value={firm.key} disabled={!firm.isActive}>
                {firm.label}
                {firm.isActive ? "" : " (inactive)"}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[12px] font-semibold text-gray-800">
            Default statement type
          </label>
          <select
            disabled={disabled || saving}
            value={draft.default_statement_type ?? ""}
            onChange={(e) => onChange("default_statement_type", e.target.value)}
            className={`${inputClass} mt-1.5 disabled:bg-gray-50`}
          >
            <option value="draft">Draft estimate</option>
            <option value="final">Final account</option>
          </select>
        </div>
      </div>
    </section>
  </div>
);

export default ClosingCostSharedRatesCard;
