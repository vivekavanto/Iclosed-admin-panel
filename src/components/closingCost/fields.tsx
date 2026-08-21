"use client";

import React from "react";
import { ChevronDown } from "lucide-react";
import { formatCurrency } from "@/lib/formatCurrency";

// The input primitives the closing-cost calculators are built from.
//
// Extracted from ClosingCostCalculator.tsx so the per-deal calculator and the
// standalone one under /admin/calculator are the SAME controls rather than two
// drifting copies of them — a clerk who learns one has learned the other.

/** Blank for anything that isn't a finite number; otherwise the plain digits. */
export function amountText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : "";
}

/** "+ $1,200.00" / "– $50,000.00" / "—" for zero. */
export function signedCurrency(n: number): string {
  const v = Math.round(n * 100) / 100;
  if (v === 0) return "—";
  return `${v < 0 ? "– " : "+ "}${formatCurrency(Math.abs(v))}`;
}

export const BalanceRow: React.FC<{
  label: string;
  value: string;
  muted?: boolean;
}> = ({ label, value, muted }) => (
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
export const PickerRow: React.FC<{
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

export const ChoiceButton: React.FC<{
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
export const Collapsible: React.FC<{
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
export const BigMoney: React.FC<{
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
export const SmallMoney: React.FC<{
  label: string;
  value: string;
  accent: string;
  placeholder?: string;
  allowNegative?: boolean;
  /** Small chip beside the label, e.g. "Required" on a final account. */
  badge?: string;
  /** Draws the field as unanswered; the panel footer reads back the reason. */
  invalid?: boolean;
  /**
   * Renders an "Is estimate" checkbox under the field. Only the four
   * provisional lines pass it — ticked, the line carries the ESTIMATE chip on
   * screen and in the PDF; unticked, it reads as a settled figure.
   */
  estimate?: { checked: boolean; onChange: (checked: boolean) => void };
  onChange: (value: string) => void;
}> = ({
  label,
  value,
  accent,
  placeholder,
  allowNegative,
  badge,
  invalid,
  estimate,
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
    {estimate && (
      <label className="flex cursor-pointer select-none items-center gap-1.5 text-[10px] font-medium text-gray-500">
        <input
          type="checkbox"
          checked={estimate.checked}
          onChange={(e) => estimate.onChange(e.target.checked)}
          className="h-3.5 w-3.5 cursor-pointer rounded border-gray-300"
          style={{ accentColor: accent }}
        />
        Is estimate
      </label>
    )}
  </div>
);

/** A compact text field for the File details block. */
export const SmallText: React.FC<{
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
