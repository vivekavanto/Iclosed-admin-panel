"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, AlertCircle, CheckCircle2, UserCog } from "lucide-react";
import AddressAutocomplete from "./shared/AddressAutocomplete";
import {
  formatPostalCode,
  isCityField,
  isPostalCodeField,
  isStreetAddressField,
} from "@/lib/addressFields";

/**
 * Personal-information task popup for a co-purchaser / co-seller, opened from
 * the "Submit on behalf" section. It loads that person's "Provide Personal
 * Information" task, renders every form field the client-facing form shows
 * (filled or empty), and lets the admin complete it on the person's behalf —
 * saving to /api/admin/task-responses and marking the task complete.
 *
 * Visual style mirrors the customer portal's PersonalInfoTaskDrawer
 * (centered modal, #C10007 accent, rounded-2xl).
 */

interface FieldOption {
  label: string;
  value: string;
}

interface FormField {
  id: string;
  field_type: string; // text | phone | email | select | textarea | checkbox | date | file
  label: string;
  placeholder: string | null;
  required: boolean;
  order_index: number;
  options: FieldOption[] | Record<string, unknown> | null;
}

interface ExistingResponse {
  id: string;
  field_id: string | null;
  field_label: string | null;
  field_type: string | null;
  value: string | null;
}

interface CoPerson {
  leadId: string;
  dealId: string;
  name: string;
  role: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  coPerson: CoPerson | null;
  onSaved: () => void;
  /**
   * When true, renders only the form body + Save button (no backdrop, header,
   * modal chrome, scroll-lock or Escape) for embedding inside the multi-party
   * accordion (AdminMultiPartyTaskDrawer). It calls onSaved() and stays open
   * (the accordion refreshes + advances) instead of auto-closing.
   */
  embedded?: boolean;
}

/* ── helpers ── */
function isSelectOptions(opts: unknown): opts is FieldOption[] {
  return Array.isArray(opts);
}

function isPhoneField(field: FormField): boolean {
  return (
    field.field_type === "phone" ||
    (field.label ?? "").toLowerCase().includes("phone")
  );
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 10);
  if (digits.length <= 3) return digits.length ? `(${digits}` : "";
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function isValidPhone(v: string) {
  return /^\(\d{3}\) \d{3}-\d{4}$/.test(v.trim());
}

function isValidEmail(v: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

const inputBase =
  "w-full px-4 py-3 text-sm text-gray-900 bg-white border rounded-lg outline-none transition-colors duration-150 placeholder:text-gray-400 placeholder:text-xs";
const inputNormal =
  "border-gray-200 focus:border-[#C10007] focus:ring-2 focus:ring-[#C10007]/10";
const inputError = "border-[#C10007] ring-2 ring-[#C10007]/10";
// Same box, left-padded to clear AddressAutocomplete's pin icon.
const inputWithIcon = inputBase.replace("px-4", "pl-9 pr-4");

/* ── custom select (fixed-position dropdown, ported from the web popup) ── */
function CustomSelect({
  value,
  onChange,
  options,
  placeholder,
  hasError,
}: {
  value: string;
  onChange: (v: string) => void;
  options: FieldOption[];
  placeholder: string;
  hasError: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const openDropdown = useCallback(() => {
    if (triggerRef.current) setRect(triggerRef.current.getBoundingClientRect());
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={openDropdown}
        className={[
          "w-full text-left px-4 py-3 text-sm rounded-lg border outline-none flex items-center justify-between transition-colors",
          hasError
            ? "border-[#C10007] ring-2 ring-[#C10007]/10"
            : open
              ? "border-[#C10007] ring-2 ring-[#C10007]/10"
              : "border-gray-200 hover:border-gray-300",
          selected ? "text-gray-900" : "text-gray-400",
        ].join(" ")}
      >
        <span className={`truncate ${selected ? "text-sm" : "text-xs text-gray-400"}`}>
          {selected ? selected.label : placeholder}
        </span>
        <svg className="w-4 h-4 text-gray-400 flex-shrink-0 ml-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && rect && (
        <div
          className="fixed z-[9999] bg-white border border-gray-200 rounded-xl shadow-xl py-1 overflow-y-auto"
          style={{ top: rect.bottom + 4, left: rect.left, width: rect.width, maxHeight: 220 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onMouseDown={() => {
                onChange(o.value);
                setOpen(false);
              }}
              className={[
                "w-full text-left px-4 py-2.5 text-sm transition-colors hover:bg-gray-50",
                o.value === value ? "font-semibold text-[#C10007] bg-[#FEF2F2]" : "text-gray-700",
              ].join(" ")}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CoPersonPersonalInfoModal({ open, onClose, coPerson, onSaved, embedded = false }: Props) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [fields, setFields] = useState<FormField[]>([]);
  // field_id → existing task_responses row (for PATCH vs POST on save)
  const [existing, setExisting] = useState<Record<string, ExistingResponse>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  // Full Name. NOT a task_form_fields row — it lives on the person's
  // lead/client record, so it loads from the deal payload and saves through
  // /api/admin/leads. Without this the co-person form had no name field at all,
  // so a co-purchaser's name could not be corrected anywhere in the admin app.
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const initialName = useRef<{ first: string; last: string }>({ first: "", last: "" });

  // Resolve the existing response for a field — match on field_id, falling
  // back to field_label for legacy rows where field_id is null.
  const findExisting = useCallback(
    (field: FormField, rows: ExistingResponse[]): ExistingResponse | undefined =>
      rows.find((r) => r.field_id === field.id) ??
      rows.find((r) => !r.field_id && (r.field_label ?? "") === field.label),
    [],
  );

  // ── Load the person's personal-information task + fields + responses ──
  useEffect(() => {
    if (!open || !coPerson) return;
    let cancelled = false;

    setLoading(true);
    setLoadError(null);
    setGlobalError(null);
    setSaved(false);
    setErrors({});
    setFields([]);
    setValues({});
    setExisting({});
    setTaskId(null);
    setFirstName("");
    setLastName("");
    initialName.current = { first: "", last: "" };

    (async () => {
      try {
        // 1. Find the person's "Provide Personal Information" task.
        const tasksRes = await fetch(`/api/admin/tasks?deal_id=${encodeURIComponent(coPerson.dealId)}`);
        if (!tasksRes.ok) throw new Error("Failed to load tasks");
        const tasks: any[] = await tasksRes.json();
        const piTask = (tasks || []).find((t) => {
          const title = String(t?.title ?? "").toLowerCase();
          return title.includes("personal info") || title.includes("personal information");
        });
        if (!piTask) {
          if (!cancelled) {
            setLoadError("No personal information task found for this person.");
            setLoading(false);
          }
          return;
        }
        if (!piTask.task_template_id) {
          if (!cancelled) {
            setLoadError("This personal information task has no form fields configured.");
            setLoading(false);
          }
          return;
        }

        // 2. Fetch the form-field definitions + any existing responses, plus the
        //    deal (which carries this person's lead_first_name / lead_last_name
        //    — the tasks endpoint only annotates owner names in family mode).
        const [fieldsRes, respRes, dealRes] = await Promise.all([
          fetch(`/api/admin/task-form-fields?task_template_id=${encodeURIComponent(piTask.task_template_id)}`),
          fetch(`/api/admin/task-responses?task_id=${encodeURIComponent(piTask.id)}`),
          fetch(`/api/admin/deals/${encodeURIComponent(coPerson.dealId)}`),
        ]);
        const fieldsData = fieldsRes.ok ? await fieldsRes.json() : [];
        const respData = respRes.ok ? await respRes.json() : [];
        const dealData = dealRes.ok ? await dealRes.json() : null;
        if (cancelled) return;

        // Non-blocking: a failed deal fetch just leaves the name blank rather
        // than breaking the whole form.
        const loadedFirst = String(dealData?.lead_first_name ?? "");
        const loadedLast = String(dealData?.lead_last_name ?? "");
        setFirstName(loadedFirst);
        setLastName(loadedLast);
        initialName.current = { first: loadedFirst, last: loadedLast };

        const loadedFields: FormField[] = (Array.isArray(fieldsData) ? fieldsData : [])
          .map((f: any) => ({
            id: String(f.id),
            field_type: f.field_type ?? "text",
            label: f.label ?? "",
            placeholder: f.placeholder ?? null,
            required: !!f.required,
            order_index: f.order_index ?? 0,
            options: f.options ?? null,
          }))
          // Personal-information tasks are text/select based; skip any file
          // fields (handled by the dedicated upload flows, not this popup).
          .filter((f: FormField) => f.field_type !== "file")
          .sort((a: FormField, b: FormField) => a.order_index - b.order_index);

        const rows: ExistingResponse[] = (Array.isArray(respData) ? respData : []).map((r: any) => ({
          id: String(r.id),
          field_id: r.field_id ?? null,
          field_label: r.field_label ?? null,
          field_type: r.field_type ?? null,
          value: r.value ?? null,
        }));

        const existingByField: Record<string, ExistingResponse> = {};
        const preValues: Record<string, string> = {};
        for (const field of loadedFields) {
          const row = findExisting(field, rows);
          if (row) {
            existingByField[field.id] = row;
            if (row.value != null) {
              preValues[field.id] = isPhoneField(field)
                ? formatPhone(row.value)
                : isPostalCodeField(field.label)
                  ? formatPostalCode(row.value)
                  : row.value;
            }
          }
        }

        // Seed the personal (not employer) phone from the lead's intake number
        // when there is no saved response yet — mirrors the portal's prefill.
        const leadPhone = String(dealData?.lead_phone ?? "").trim();
        if (leadPhone) {
          const phoneField = loadedFields.find((f) => {
            const l = (f.label ?? "").toLowerCase();
            return (
              (f.field_type === "phone" || l.includes("phone")) &&
              !l.includes("employer") &&
              !l.includes("business")
            );
          });
          if (phoneField && !(preValues[phoneField.id] ?? "").trim()) {
            preValues[phoneField.id] = formatPhone(leadPhone);
          }
        }

        setTaskId(piTask.id);
        setFields(loadedFields);
        setExisting(existingByField);
        setValues(preValues);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : "Failed to load form.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, coPerson, findExisting]);

  // ── Escape to close + body scroll lock ── skipped when embedded (the parent
  // accordion owns Escape and scroll-lock).
  useEffect(() => {
    if (!open || embedded) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", handle);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handle);
      document.body.style.overflow = "";
    };
  }, [open, saving, onClose, embedded]);

  function setValue(field: FormField, raw: string) {
    const v = isPhoneField(field)
      ? formatPhone(raw)
      : isPostalCodeField(field.label)
        ? formatPostalCode(raw)
        : raw;
    setValues((prev) => ({ ...prev, [field.id]: v }));
    if (errors[field.id]) setErrors((prev) => ({ ...prev, [field.id]: "" }));
  }

  // A Google Places pick also fills the City / Postal Code siblings, found by
  // label. Skips components Google omits, so nothing already typed is blanked.
  function applyAddressSelection(
    streetField: FormField,
    address: { street: string; city: string; postalCode: string },
  ) {
    const textFields = fields.filter((f) => f.field_type === "text");
    const cityField = textFields.find((f) => isCityField(f.label));
    const postalField = textFields.find((f) => isPostalCodeField(f.label));

    const filled: Record<string, string> = { [streetField.id]: address.street };
    if (cityField && address.city) filled[cityField.id] = address.city;
    if (postalField && address.postalCode) {
      filled[postalField.id] = formatPostalCode(address.postalCode);
    }

    setValues((prev) => ({ ...prev, ...filled }));
    setErrors((prev) => {
      const next = { ...prev };
      for (const id of Object.keys(filled)) next[id] = "";
      return next;
    });
  }

  function validate(): boolean {
    const next: Record<string, string> = {};
    for (const field of fields) {
      const val = (values[field.id] ?? "").trim();
      if (field.field_type === "checkbox") {
        if (field.required && values[field.id] !== "true") {
          next[field.id] = `${field.label} is required.`;
        }
        continue;
      }
      if (field.required && !val) {
        next[field.id] = `${field.label} is required.`;
        continue;
      }
      if (val && field.field_type === "email" && !isValidEmail(val)) {
        next[field.id] = "Enter a valid email address.";
      } else if (val && isPhoneField(field) && !isValidPhone(val)) {
        next[field.id] = "Enter a valid phone number in (416) 555-1234 format.";
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSave() {
    if (!taskId) return;
    if (!validate()) return;

    setSaving(true);
    setGlobalError(null);
    try {
      // Full Name first: it is not a task response, so it goes through the leads
      // endpoint, which also mirrors it to `clients` and cascades to this
      // person's other files. Keyed on coPerson.leadId, so it renames THIS
      // co-purchaser/co-seller and never the primary.
      const nextFirst = firstName.trim();
      const nextLast = lastName.trim();
      if (
        coPerson?.leadId &&
        (nextFirst !== initialName.current.first || nextLast !== initialName.current.last)
      ) {
        const nameRes = await fetch("/api/admin/leads", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: coPerson.leadId,
            firstName: nextFirst,
            lastName: nextLast,
          }),
        });
        const nameJson = await nameRes.json();
        if (!nameRes.ok || !nameJson.success) {
          throw new Error(nameJson.error || "Failed to save the name");
        }
        initialName.current = { first: nextFirst, last: nextLast };
        // The name saved on the file even if the customer record lagged behind —
        // show that rather than claiming a clean save.
        if (Array.isArray(nameJson.warnings) && nameJson.warnings.length > 0) {
          setGlobalError(nameJson.warnings[0]);
        }
      }

      for (const field of fields) {
        const value =
          field.field_type === "checkbox"
            ? values[field.id] === "true"
              ? "true"
              : "false"
            : values[field.id] ?? "";
        const row = existing[field.id];

        if (row) {
          // PATCH only when the value actually changed.
          if ((row.value ?? "") !== value) {
            const res = await fetch("/api/admin/task-responses", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: row.id, value }),
            });
            const j = await res.json();
            if (!res.ok || !j.success) throw new Error(j.error || "Failed to update response");
          }
        } else if (value !== "" || field.field_type === "checkbox") {
          // POST a new response for a field the client left blank.
          const res = await fetch("/api/admin/task-responses", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              task_id: taskId,
              field_id: field.id,
              field_label: field.label,
              field_type: field.field_type,
              value,
            }),
          });
          const j = await res.json();
          if (!res.ok || !j.success) throw new Error(j.error || "Failed to create response");
        }
      }

      // Filling and saving the personal-information form completes it (mirrors
      // the customer portal's auto-complete on submit and the admin Edit Task
      // modal behaviour).
      const taskRes = await fetch("/api/admin/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: taskId,
          status: "Completed",
          completed: true,
          completed_at: new Date().toISOString(),
        }),
      });
      const taskJson = await taskRes.json();
      if (!taskRes.ok || !taskJson.success) {
        throw new Error(taskJson.error || "Failed to complete task");
      }

      setSaved(true);
      onSaved();
      // Embedded in the accordion: stay open — the parent refreshes status and
      // advances to the next incomplete person. Standalone modal: auto-close.
      if (!embedded) setTimeout(() => onClose(), 1200);
    } catch (err) {
      setGlobalError(err instanceof Error ? err.message : "Could not save. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!open || !coPerson) return null;

  return (
    <>
      {/* Backdrop — omitted when embedded (parent accordion owns chrome). */}
      {!embedded && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm"
          onClick={() => !saving && onClose()}
          aria-hidden="true"
        />
      )}

      {/* Modal — same sizing as the Upload Identification popup; plain flow when embedded. */}
      <div
        className={
          embedded
            ? "flex flex-col bg-white"
            : "fixed z-[70] inset-4 sm:inset-8 md:inset-12 lg:inset-16 xl:inset-20 max-w-5xl max-h-[90vh] mx-auto my-auto flex flex-col rounded-2xl border border-gray-100 bg-white shadow-2xl"
        }
        role={embedded ? undefined : "dialog"}
        aria-modal={embedded ? undefined : "true"}
      >
        {/* Header — omitted when embedded (the accordion section header stands in) */}
        {!embedded && (
          <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-gray-100">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-full bg-[#FEF2F2] flex items-center justify-center text-[#C10007] flex-shrink-0">
                <UserCog size={17} strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-gray-900 leading-snug truncate">
                  Provide Personal Information
                </h2>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                  {coPerson.role} · {coPerson.name}
                </p>
              </div>
            </div>
            <button
              onClick={() => !saving && onClose()}
              className="cursor-pointer flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}

        {/* Body */}
        <div className={embedded ? "px-6 py-6 space-y-5" : "flex-1 overflow-y-auto px-6 py-6 space-y-5"}>
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={22} className="text-gray-300 animate-spin" />
            </div>
          )}

          {!loading && loadError && (
            <div className="flex items-start gap-3 rounded-xl border border-[#fca5a5] bg-[#FEF2F2] px-4 py-4">
              <AlertCircle size={18} className="text-[#C10007] flex-shrink-0 mt-0.5" />
              <p className="text-sm text-gray-700">{loadError}</p>
            </div>
          )}

          {!loading && !loadError && saved && (
            <div className="flex items-center gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-4">
              <CheckCircle2 size={20} className="text-green-600 flex-shrink-0" strokeWidth={2} />
              <div>
                <p className="text-sm font-bold text-green-700">Saved successfully!</p>
                <p className="text-xs text-green-600 mt-0.5">
                  The personal information has been recorded.
                </p>
              </div>
            </div>
          )}

          {/* Full Name — rendered above the template fields, mirroring where the
              customer portal shows it. It is not a task_form_fields row, so it
              is not part of `fields` and saves separately (see handleSave). */}
          {!loading && !loadError && !saved && (
            <div>
              <label className="text-sm font-semibold text-gray-800 mb-2 block">
                Full Name
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  placeholder="First name"
                  aria-label="First name"
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  placeholder="Last name"
                  aria-label="Last name"
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-xl bg-white focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                />
              </div>
              <p className="text-[11px] text-gray-400 mt-1.5">
                Saving updates this person everywhere — their other files, the client
                portal, and emails.
              </p>
            </div>
          )}

          {!loading && !loadError && !saved && fields.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <p className="text-sm text-gray-500 font-medium">No other form fields to fill.</p>
            </div>
          )}

          {!loading && !loadError && !saved &&
            fields.map((field) => {
              const hasError = !!errors[field.id];
              const labelEl = (
                <label className="text-sm font-semibold text-gray-800 mb-2 block">
                  {field.label}
                  {field.required && <span className="text-[#C10007] ml-1">*</span>}
                </label>
              );

              if (field.field_type === "checkbox") {
                const isChecked = values[field.id] === "true";
                return (
                  <div key={field.id}>
                    <label className="flex items-start gap-3 cursor-pointer group select-none">
                      <div className="relative flex-shrink-0 mt-0.5">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={(e) => setValue(field, e.target.checked ? "true" : "false")}
                          className="sr-only"
                        />
                        <div
                          className={[
                            "w-5 h-5 rounded border-2 flex items-center justify-center transition-all",
                            isChecked
                              ? "bg-[#C10007] border-[#C10007]"
                              : "border-gray-300 bg-white group-hover:border-[#C10007]/60",
                          ].join(" ")}
                        >
                          {isChecked && (
                            <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
                              <path d="M1 4L3.5 6.5L9 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <span className={["text-sm leading-snug pt-0.5", isChecked ? "text-gray-800 font-medium" : "text-gray-500"].join(" ")}>
                        {field.placeholder || field.label}
                      </span>
                    </label>
                    {hasError && <p className="mt-1.5 text-xs text-[#C10007]">{errors[field.id]}</p>}
                  </div>
                );
              }

              if (field.field_type === "select") {
                const opts = isSelectOptions(field.options) ? field.options : [];
                return (
                  <div key={field.id}>
                    {labelEl}
                    <CustomSelect
                      value={values[field.id] ?? ""}
                      onChange={(v) => setValue(field, v)}
                      options={opts}
                      placeholder={field.placeholder ?? `Select ${field.label}`}
                      hasError={hasError}
                    />
                    {hasError && <p className="mt-1.5 text-xs text-[#C10007]">{errors[field.id]}</p>}
                  </div>
                );
              }

              if (field.field_type === "textarea") {
                return (
                  <div key={field.id}>
                    {labelEl}
                    <textarea
                      value={values[field.id] ?? ""}
                      onChange={(e) => setValue(field, e.target.value)}
                      placeholder={field.placeholder ?? ""}
                      rows={3}
                      className={[inputBase, hasError ? inputError : inputNormal, "resize-none"].join(" ")}
                    />
                    {hasError && <p className="mt-1.5 text-xs text-[#C10007]">{errors[field.id]}</p>}
                  </div>
                );
              }

              const inputType =
                field.field_type === "email"
                  ? "email"
                  : field.field_type === "date"
                    ? "date"
                    : isPhoneField(field)
                      ? "tel"
                      : "text";

              const isMailForwardingStart =
                (field.label || "").trim().toLowerCase() === "street address";
              // Street Address gets Google Places suggestions.
              const isStreet =
                field.field_type === "text" && isStreetAddressField(field.label);
              return (
                <Fragment key={field.id}>
                  {isMailForwardingStart && (
                    <p className="text-sm font-bold text-gray-900">Mail forwarding address</p>
                  )}
                  <div>
                  {labelEl}
                  {isStreet ? (
                    <AddressAutocomplete
                      value={values[field.id] ?? ""}
                      onChange={(v) => setValue(field, v)}
                      onSelect={(address) => applyAddressSelection(field, address)}
                      placeholder={field.placeholder ?? "123 Main Street"}
                      hasError={hasError}
                      // Mailing address, not the property — allow all of Canada.
                      restrictToOntario={false}
                      inputClassName={[
                        inputWithIcon,
                        hasError ? inputError : inputNormal,
                      ].join(" ")}
                    />
                  ) : (
                  <input
                    type={inputType}
                    value={values[field.id] ?? ""}
                    onChange={(e) => setValue(field, e.target.value)}
                    placeholder={field.placeholder ?? ""}
                    className={[inputBase, hasError ? inputError : inputNormal].join(" ")}
                  />
                  )}
                  {hasError && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-[#C10007]">
                      <AlertCircle size={11} />
                      {errors[field.id]}
                    </p>
                  )}
                  </div>
                </Fragment>
              );
            })}

          {globalError && (
            <div className="flex items-start gap-2 rounded-lg bg-[#FEF2F2] border border-[#fca5a5] px-4 py-3">
              <AlertCircle size={14} className="text-[#C10007] flex-shrink-0 mt-0.5" />
              <p className="text-xs text-[#C10007]">{globalError}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {!loading && !loadError && !saved && fields.length > 0 && (
          <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
            {!embedded && (
              <button
                type="button"
                onClick={() => !saving && onClose()}
                disabled={saving}
                className="px-4 py-2.5 rounded-lg text-sm font-semibold border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50 cursor-pointer"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-bold bg-[#C10007] text-white hover:bg-[#a30006] disabled:opacity-50 cursor-pointer"
            >
              {saving && <Loader2 size={15} className="animate-spin" />}
              Save information
            </button>
          </div>
        )}
      </div>
    </>
  );
}
