"use client";

import React from "react";
import {
  BRAND,
  inputClass,
  type Draft,
  type FieldSection,
} from "@/lib/closingCostSettingsFields";

// One titled card of numeric fee/rate inputs. Shared by the per-firm and the
// shared-rates cards so both render fees identically.

const ClosingCostFieldSection: React.FC<{
  section: FieldSection;
  draft: Draft;
  disabled?: boolean;
  onChange: (key: string, value: string) => void;
}> = ({ section, draft, disabled, onChange }) => (
  <section className="rounded-xl border border-gray-200 bg-white p-5">
    <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
      {section.title.toUpperCase()}
    </h2>
    {section.note && (
      <p className="mt-1 text-[11px] leading-relaxed text-gray-400">{section.note}</p>
    )}
    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
      {section.fields.map((field) => (
        <div key={field.key}>
          <label className="block text-[12px] font-semibold text-gray-800">
            {field.label}
            {field.hint && (
              <span className="ml-1 font-normal text-gray-400">— {field.hint}</span>
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
              disabled={disabled}
              value={draft[field.key] ?? ""}
              onChange={(e) => onChange(field.key, e.target.value)}
              className={`${inputClass} tabular-nums disabled:bg-gray-50 ${
                field.prefix ? "pl-7" : ""
              }`}
            />
          </div>
        </div>
      ))}
    </div>
  </section>
);

export default ClosingCostFieldSection;
