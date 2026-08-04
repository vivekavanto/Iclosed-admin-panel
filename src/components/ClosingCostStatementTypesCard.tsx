"use client";

import React from "react";
import { Loader2, Save } from "lucide-react";
import {
  BRAND,
  STATEMENT_TEXT_FIELDS,
  inputClass,
  type Draft,
} from "@/lib/closingCostSettingsFields";
import type { StatementTypeKey } from "@/lib/closingCostSettings";

// The client-facing wording for each flavour of statement.
//
// The line items and the maths are identical between them — only the title, the
// on-screen heading, the leading disclaimer, an optional footer note and the
// watermark differ. The remaining disclaimer paragraphs are standing legal text
// and stay in src/lib/closingCosts.ts, which the customer portal shares.
//
// Note this is NOT the estimate's workflow status (draft vs issued): an issued
// estimate can still be a draft statement.

const ClosingCostStatementTypesCard: React.FC<{
  typeKey: StatementTypeKey;
  label: string;
  draft: Draft;
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  onChange: (key: string, value: string) => void;
  onToggleWatermark: (next: boolean) => void;
  onSave: () => void;
}> = ({
  typeKey,
  label,
  draft,
  dirty,
  saving,
  disabled,
  onChange,
  onToggleWatermark,
  onSave,
}) => {
  const watermarkOn = draft.show_watermark === "true";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">{label}</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">
            {typeKey === "draft"
              ? "A preliminary estimate — figures are not yet final."
              : "The final account, issued once the figures are settled."}
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
          Save {label.toLowerCase()}
        </button>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
          WORDING
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
          Printed on the PDF and shown above the statement on screen.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-[12px] font-semibold text-gray-800">
              Tab label
            </label>
            <input
              type="text"
              disabled={disabled || saving}
              value={draft.label ?? ""}
              onChange={(e) => onChange("label", e.target.value)}
              className={`${inputClass} mt-1.5 disabled:bg-gray-50`}
            />
          </div>

          {STATEMENT_TEXT_FIELDS.map((field) => (
            <div key={field.key}>
              <label className="block text-[12px] font-semibold text-gray-800">
                {field.label}
                {field.hint && (
                  <span className="ml-1 font-normal text-gray-400">— {field.hint}</span>
                )}
              </label>
              {field.multiline ? (
                <textarea
                  rows={3}
                  disabled={disabled || saving}
                  value={draft[field.key] ?? ""}
                  onChange={(e) => onChange(field.key, e.target.value)}
                  className={`${inputClass} mt-1.5 resize-y leading-relaxed disabled:bg-gray-50`}
                />
              ) : (
                <input
                  type="text"
                  disabled={disabled || saving}
                  value={draft[field.key] ?? ""}
                  onChange={(e) => onChange(field.key, e.target.value)}
                  className={`${inputClass} mt-1.5 disabled:bg-gray-50`}
                />
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
          WATERMARK
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
          Drawn faintly across the page so a working copy can never be mistaken for the
          statement actually sent to the client.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] font-semibold text-gray-700">
            <input
              type="checkbox"
              checked={watermarkOn}
              disabled={disabled || saving}
              onChange={(e) => onToggleWatermark(e.target.checked)}
              className="h-4 w-4 accent-[#C10007]"
            />
            Show a watermark
          </label>
          <input
            type="text"
            aria-label="Watermark text"
            disabled={disabled || saving || !watermarkOn}
            value={draft.watermark_text ?? ""}
            onChange={(e) => onChange("watermark_text", e.target.value)}
            className={`${inputClass} w-48 uppercase tracking-wide disabled:bg-gray-50 disabled:text-gray-400`}
          />
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-gray-50 p-5">
        <h2 className="text-[11px] font-bold tracking-wide text-gray-400">PREVIEW</h2>
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-4">
          <p className="text-[10px] font-bold tracking-wide" style={{ color: BRAND }}>
            {(draft.title ?? "").toUpperCase()}
          </p>
          <p className="mt-3 text-[11px] font-bold text-gray-800">
            {draft.disclaimer_intro}
          </p>
          {(draft.footer_note ?? "").trim() && (
            <p className="mt-1.5 text-[10px] italic text-gray-500">{draft.footer_note}</p>
          )}
        </div>
      </section>
    </div>
  );
};

export default ClosingCostStatementTypesCard;
