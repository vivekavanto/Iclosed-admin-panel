"use client";

import React from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import type { Tier } from "@/lib/closingCosts";
import { formatCurrency, parseAmountInput } from "@/lib/formatCurrency";
import { BRAND, bandLabel } from "@/lib/closingCostSettingsFields";

// Add/remove/edit rows of a marginal bracket table (Ontario LTT, Toronto MLTT).
//
// Extracted verbatim from ClosingCostSettings so the shared-rates card can use
// it without the settings shell having to own bracket-editing state.

const ClosingCostTierEditor: React.FC<{
  title: string;
  note: string;
  tiers: Tier[];
  disabled?: boolean;
  onChange: (tiers: Tier[]) => void;
  onReset: () => void;
}> = ({ title, note, tiers, disabled, onChange, onReset }) => {
  const setCap = (index: number, raw: string) => {
    const next = tiers.map((t) => [...t] as Tier);
    next[index][0] = parseAmountInput(raw);
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
          disabled={disabled}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
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
                {bandLabel(prevCap, tier[0], (n) => formatCurrency(n, { cents: false }))}
              </span>
              {isLast ? (
                <span className="px-2 text-[11px] italic text-gray-400">and above</span>
              ) : (
                <input
                  type="text"
                  inputMode="decimal"
                  disabled={disabled}
                  value={tier[0] === null ? "" : String(tier[0])}
                  onChange={(e) => setCap(index, e.target.value)}
                  className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[12px] tabular-nums focus:border-[#C10007] focus:outline-none focus:ring-1 focus:ring-[#C10007] disabled:bg-gray-50"
                />
              )}
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  disabled={disabled}
                  value={String(Number((tier[1] * 100).toFixed(6)))}
                  onChange={(e) => setRate(index, e.target.value)}
                  className="w-full rounded-md border border-gray-200 pl-2 pr-5 py-1.5 text-[12px] tabular-nums focus:border-[#C10007] focus:outline-none focus:ring-1 focus:ring-[#C10007] disabled:bg-gray-50"
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
                  disabled={disabled}
                  aria-label="Remove band"
                  className="justify-self-center text-gray-300 hover:text-red-600 disabled:opacity-40"
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
        disabled={disabled}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        <Plus size={12} /> Add band
      </button>
    </section>
  );
};

export default ClosingCostTierEditor;
