"use client";

import React from "react";
import {
  Image as ImageIcon,
  Loader2,
  Save,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import ClosingCostFieldSection from "./ClosingCostFieldSection";
import { docDownloadHref } from "@/lib/blobPrivacy";
import {
  BRAND,
  FIRM_SECTIONS,
  LETTERHEAD_FIELDS,
  inputClass,
  type Draft,
} from "@/lib/closingCostSettingsFields";

// One firm profile: its own legal & admin fees, its search-and-review charges,
// its letterhead and its brand colour.
//
// Statutory values are deliberately absent — they are edited once in the shared
// card so a bracket change can never apply to one firm and not the other.

const ClosingCostFirmCard: React.FC<{
  label: string;
  draft: Draft;
  /** Blob URL of the letterhead logo, or "" when the firm has none. */
  logoUrl: string;
  isActive: boolean;
  dirty: boolean;
  saving: boolean;
  disabled?: boolean;
  /** True for a firm that inherits the incumbent's address and HST number. */
  isDivision?: boolean;
  onChange: (key: string, value: string) => void;
  onToggleActive: (next: boolean) => void;
  onSave: () => void;
  /** Uploads immediately — the logo is not part of the Save payload. */
  onLogoUpload: (file: File) => Promise<void>;
  onLogoRemove: () => Promise<void>;
}> = ({
  label,
  draft,
  logoUrl,
  isActive,
  dirty,
  saving,
  disabled,
  isDivision,
  onChange,
  onToggleActive,
  onSave,
  onLogoUpload,
  onLogoRemove,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const brandColor = draft.brand_color || "#C10007";
  const placeholderLeft = LETTERHEAD_FIELDS.some((f) =>
    (draft[f.key] ?? "").trim().startsWith("SET "),
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-5 py-4">
        <div>
          <h2 className="text-sm font-bold text-gray-900">{label}</h2>
          <p className="mt-0.5 text-[11px] text-gray-400">
            {isActive
              ? "Selectable when preparing an estimate."
              : "Hidden from the calculator until activated."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] font-semibold text-gray-700">
            <input
              type="checkbox"
              checked={isActive}
              disabled={disabled || saving}
              onChange={(e) => onToggleActive(e.target.checked)}
              className="h-4 w-4 accent-[#C10007]"
            />
            Active
          </label>
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || saving || !dirty}
            className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2.5 text-xs font-semibold text-white disabled:opacity-50"
            style={{ backgroundColor: BRAND }}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save {label}
          </button>
        </div>
      </div>

      {placeholderLeft && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-900">
          <TriangleAlert size={14} className="mt-0.5 shrink-0" />
          <span>
            This firm&apos;s letterhead still contains placeholder text. Fill it in before
            activating — it is printed at the top of every statement of account.
          </span>
        </div>
      )}

      {FIRM_SECTIONS.map((section) => (
        <ClosingCostFieldSection
          key={section.title}
          section={section}
          draft={draft}
          disabled={disabled || saving}
          onChange={onChange}
        />
      ))}

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
          PDF LETTERHEAD
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
          Printed at the top of every generated estimate PDF.
          {isDivision &&
            " iClosed is a division of Nava Wilson, so it shares the address, telephone, fax and HST number — change them here only if that stops being true."}
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {LETTERHEAD_FIELDS.map((field) => (
            <div key={field.key} className={field.wide ? "sm:col-span-2" : undefined}>
              <label className="block text-[12px] font-semibold text-gray-800">
                {field.label}
                {field.hint && (
                  <span className="ml-1 font-normal text-gray-400">— {field.hint}</span>
                )}
              </label>
              <input
                type="text"
                disabled={disabled || saving}
                value={draft[field.key] ?? ""}
                onChange={(e) => onChange(field.key, e.target.value)}
                className={`${inputClass} mt-1.5 disabled:bg-gray-50`}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
          LETTERHEAD LOGO
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
          Printed at the top of this firm&rsquo;s statements in place of the firm name.
          PNG or JPG only, up to 2&nbsp;MB — a PDF cannot embed an SVG. Leave it empty
          to print the firm name as text instead.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-56 items-center justify-center rounded-lg border border-dashed border-gray-200 bg-gray-50 p-2">
            {logoUrl ? (
              // A Blob URL on an arbitrary host: next/image would need a
              // remotePatterns entry per store and buys nothing for a 2 MB
              // letterhead mark shown once on a settings page.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                // New logos are public and render directly. A logo uploaded
                // before that was settled sits in the private store, where the
                // browser gets a 401 — docDownloadHref routes those through the
                // auth-gated proxy so an existing one still previews.
                src={docDownloadHref(logoUrl)}
                alt={`${label} logo`}
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <ImageIcon size={14} /> No logo
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                // Clear the input first so re-picking the SAME file still fires
                // a change event.
                e.target.value = "";
                if (!file) return;
                setBusy(true);
                try {
                  await onLogoUpload(file);
                } finally {
                  setBusy(false);
                }
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Upload size={13} />
              )}
              {logoUrl ? "Replace logo" : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                type="button"
                onClick={async () => {
                  if (!window.confirm(`Remove the ${label} logo?`)) return;
                  setBusy(true);
                  try {
                    await onLogoRemove();
                  } finally {
                    setBusy(false);
                  }
                }}
                disabled={disabled || busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-500 hover:bg-gray-50 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 size={13} /> Remove
              </button>
            )}
            <p className="text-[10px] text-gray-400">
              Saved as soon as you choose a file — the Save button above is for the
              other fields.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="text-[11px] font-bold tracking-wide" style={{ color: BRAND }}>
          BRAND COLOUR
        </h2>
        <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
          Used for the PDF letterhead band, the section headings and the totals bar.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="color"
            aria-label="Brand colour"
            disabled={disabled || saving}
            value={/^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#C10007"}
            onChange={(e) => onChange("brand_color", e.target.value.toUpperCase())}
            className="h-10 w-14 cursor-pointer rounded-lg border border-gray-200 bg-white p-1"
          />
          <input
            type="text"
            disabled={disabled || saving}
            value={draft.brand_color ?? ""}
            onChange={(e) => onChange("brand_color", e.target.value)}
            placeholder="#C10007"
            className={`${inputClass} w-40 font-mono uppercase tabular-nums disabled:bg-gray-50`}
          />
          <div
            className="flex h-10 flex-1 items-center rounded-lg px-3 text-[11px] font-bold tracking-wide text-white"
            style={{
              backgroundColor: /^#[0-9a-fA-F]{6}$/.test(brandColor)
                ? brandColor
                : "#C10007",
            }}
          >
            {(draft.firm_name || label).toUpperCase()}
          </div>
        </div>
      </section>
    </div>
  );
};

export default ClosingCostFirmCard;
