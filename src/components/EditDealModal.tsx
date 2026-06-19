"use client";

import React, { useEffect, useRef, useState } from "react";
import { X, Loader2, ExternalLink } from "lucide-react";
import Link from "next/link";
import { computeDealDisplayStatus } from "@/lib/dealDisplayStatus";

type DealRow = {
  id: string;
  // Client name lives on the linked lead (not the deal), so it saves through
  // the leads endpoint. lead_id is captured so we know which lead to update.
  lead_id?: string | null;
  lead_first_name?: string | null;
  lead_last_name?: string | null;
  file_number?: string | null;
  file_name?: string | null;
  type?: string | null;
  status?: string | null;
  lawyer_name?: string | null;
  clerk_name?: string | null;
  property_address?: string | null;
  closing_date?: string | null;
  opening_date?: string | null;
  requisition_date?: string | null;
  price?: number | null;
  outstanding_undertakings?: number | null;
  outstanding_requisitions?: number | null;
};

type Toast = { message: string; type: "success" | "error" } | null;

interface EditDealModalProps {
  dealId: string;
  onClose: () => void;
  onSaved?: () => void;
}

const TYPE_OPTIONS = ["Purchase", "Sale", "Refinance", "Purchase & Sale"];
const STATUS_OPTIONS = ["Active", "Inactive", "Closed"];

// Native <input type="date"> in Chrome allows the user to type a 6-digit
// year. Restrict to a sane real-world window matching the rest of the app
// (DealList filters use the same range).
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

// Reject anything outside the supported range so a stray 6-digit year never
// makes it to the database. Empty strings are valid (clears the field).
function isValidDateInput(value: string | null | undefined): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value >= DATE_MIN && value <= DATE_MAX;
}

// Convert API date (which may be "YYYY-MM-DD" or full timestamp) into the
// "YYYY-MM-DD" format a native date input expects.
function toDateInputValue(value?: string | null): string {
  if (!value) return "";
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : "";
}

const EditDealModal: React.FC<EditDealModalProps> = ({ dealId, onClose, onSaved }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  };

  // Snapshot of editable deal fields (controlled inputs). Tasks and stages
  // are no longer edited here — they have inline edit affordances on the
  // deal detail page.
  const [form, setForm] = useState<DealRow>({ id: dealId });

  // The client name loaded from the server, so a save only hits the leads
  // endpoint when the admin actually changed it.
  const initialNameRef = useRef<{ first: string; last: string }>({ first: "", last: "" });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const dealRes = await fetch(`/api/admin/deals/${dealId}`);
        const deal = await dealRes.json();
        if (cancelled) return;
        if (deal && !deal.error) {
          setForm({
            id: deal.id,
            lead_id: deal.lead_id ?? null,
            lead_first_name: deal.lead_first_name ?? "",
            lead_last_name: deal.lead_last_name ?? "",
            file_number: deal.file_number ?? "",
            file_name: deal.file_name ?? "",
            type: deal.type ?? "",
            // Show the same derived status as the deal list: "Active" once the
            // client has signed in (account_created_at), else "Inactive";
            // "Closed" is taken from the raw DB value. Prevents the stale-DB
            // mismatch where the list showed Active but this showed Inactive.
            status: computeDealDisplayStatus({
              status: deal.status,
              account_created_at: deal.account_created_at,
            }),
            lawyer_name: deal.lawyer_name ?? "",
            clerk_name: deal.clerk_name ?? "",
            property_address: deal.property_address ?? "",
            closing_date: toDateInputValue(deal.closing_date),
            opening_date: toDateInputValue(deal.opening_date),
            requisition_date: toDateInputValue(deal.requisition_date),
            price: deal.price ?? 0,
            outstanding_undertakings: deal.outstanding_undertakings ?? 0,
            outstanding_requisitions: deal.outstanding_requisitions ?? 0,
          });
          initialNameRef.current = {
            first: deal.lead_first_name ?? "",
            last: deal.lead_last_name ?? "",
          };
        }
      } catch (err) {
        console.error("[EditDealModal] load failed", err);
        showToast("Failed to load deal", "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const updateField = <K extends keyof DealRow>(key: K, value: DealRow[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveDetails = async () => {
    for (const [label, value] of [
      ["Closing date", form.closing_date],
      ["Opening date", form.opening_date],
      ["Requisition date", form.requisition_date],
    ] as const) {
      if (!isValidDateInput(value)) {
        showToast(`${label} must be between 1900 and 2100`, "error");
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        file_number: form.file_number ?? "",
        file_name: form.file_name ?? "",
        type: form.type ?? "",
        status: form.status ?? "Active",
        lawyer_name: form.lawyer_name ?? "",
        clerk_name: form.clerk_name ?? "",
        property_address: form.property_address ?? "",
        closing_date: form.closing_date ?? "",
        opening_date: form.opening_date ?? "",
        requisition_date: form.requisition_date ?? "",
        price: Number(form.price) || 0,
        outstanding_undertakings: Number(form.outstanding_undertakings) || 0,
        outstanding_requisitions: Number(form.outstanding_requisitions) || 0,
      };
      const res = await fetch(`/api/admin/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Save failed");
      }
      // Client name is stored on the deal's lead, not the deal row — persist it
      // through the leads endpoint, but only when it actually changed.
      const nameChanged =
        (form.lead_first_name ?? "") !== initialNameRef.current.first ||
        (form.lead_last_name ?? "") !== initialNameRef.current.last;
      if (nameChanged && form.lead_id) {
        const leadRes = await fetch(`/api/admin/leads`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: form.lead_id,
            firstName: form.lead_first_name ?? "",
            lastName: form.lead_last_name ?? "",
          }),
        });
        const leadData = await leadRes.json();
        if (!leadRes.ok || !leadData.success) {
          throw new Error(leadData.error || "Client name save failed");
        }
        initialNameRef.current = {
          first: form.lead_first_name ?? "",
          last: form.lead_last_name ?? "",
        };
      }
      const mirrored = Number(data.mirrored) || 0;
      showToast(
        mirrored > 0
          ? `Deal updated — synced to ${mirrored} linked ${mirrored === 1 ? "deal" : "deals"}`
          : "Deal updated",
      );
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------- render --

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit deal"
      className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
      onClick={onClose}
    >
      <div
        className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right relative lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-gray-900">Edit deal</h2>
            <p className="text-xs text-gray-400 mt-1">
              {form.file_number ? `File ${form.file_number}` : "Loading…"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-6">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-gray-500 gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : (
            <>
            <div className="mb-5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              File-level fields (status, lawyer, clerk, dates, price, file name,
              outstanding counts) sync across every linked co-purchaser/co-seller
              deal in this file. File number, type, and property address stay
              per-deal — edit those from each linked deal's detail page.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <Field label="File number" required>
                <input
                  type="text"
                  value={form.file_number ?? ""}
                  onChange={(e) => updateField("file_number", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="File name">
                <input
                  type="text"
                  value={form.file_name ?? ""}
                  onChange={(e) => updateField("file_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              {/* Client name lives on this deal's lead (saved via the leads
                  endpoint), not on the deal row — it's per-deal, so it does not
                  mirror across the family. */}
              <Field label="Client first name">
                <input
                  type="text"
                  value={form.lead_first_name ?? ""}
                  onChange={(e) => updateField("lead_first_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Client last name">
                <input
                  type="text"
                  value={form.lead_last_name ?? ""}
                  onChange={(e) => updateField("lead_last_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Type">
                <select
                  value={form.type ?? ""}
                  onChange={(e) => updateField("type", e.target.value)}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={form.status ?? "Active"}
                  onChange={(e) => updateField("status", e.target.value)}
                  className={inputClass}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                  {/* Legacy values from before the status set was trimmed —
                      surfaced so admins see the real value and can choose
                      whether to replace it with one of the three. */}
                  {form.status && !STATUS_OPTIONS.includes(form.status) && (
                    <option value={form.status}>{form.status} (legacy)</option>
                  )}
                </select>
              </Field>
              <Field label="Lawyer">
                <input
                  type="text"
                  value={form.lawyer_name ?? ""}
                  onChange={(e) => updateField("lawyer_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Clerk">
                <input
                  type="text"
                  value={form.clerk_name ?? ""}
                  onChange={(e) => updateField("clerk_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Property address" className="md:col-span-2">
                <input
                  type="text"
                  value={form.property_address ?? ""}
                  onChange={(e) =>
                    updateField("property_address", e.target.value)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Closing date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.closing_date ?? ""}
                  onChange={(e) => updateField("closing_date", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Opening date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.opening_date ?? ""}
                  onChange={(e) => updateField("opening_date", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Requisition date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.requisition_date ?? ""}
                  onChange={(e) =>
                    updateField("requisition_date", e.target.value)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Price">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price ?? 0}
                  onChange={(e) =>
                    updateField("price", Number(e.target.value) as any)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Outstanding undertakings">
                <input
                  type="number"
                  min={0}
                  value={form.outstanding_undertakings ?? 0}
                  onChange={(e) =>
                    updateField(
                      "outstanding_undertakings",
                      Number(e.target.value) as any,
                    )
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Outstanding requisitions">
                <input
                  type="number"
                  min={0}
                  value={form.outstanding_requisitions ?? 0}
                  onChange={(e) =>
                    updateField(
                      "outstanding_requisitions",
                      Number(e.target.value) as any,
                    )
                  }
                  className={inputClass}
                />
              </Field>
            </div>
            </>
          )}
        </div>

        <div className="flex flex-col gap-3 px-6 py-4 border-t border-gray-100">
          <Link
            href={`/admin/deals/${dealId}`}
            className="text-xs font-semibold text-[#C10007] hover:underline inline-flex items-center gap-1 self-start"
          >
            <ExternalLink size={12} />
            Open full deal view
          </Link>
          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
            >
              Close
            </button>
            <button
              onClick={handleSaveDetails}
              disabled={saving || loading}
              className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-60 inline-flex items-center justify-center gap-2"
            >
              {saving && <Loader2 size={14} className="animate-spin" />}
              Save changes
            </button>
          </div>
        </div>

        {toast && (
          <div
            className={`absolute bottom-20 right-6 px-3 py-2 rounded shadow-md text-xs font-medium ${
              toast.type === "success"
                ? "bg-green-600 text-white"
                : "bg-red-600 text-white"
            }`}
          >
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
};

const inputClass =
  "w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white";

const Field: React.FC<{
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ label, required, className, children }) => (
  <div className={className}>
    <label className="block text-sm font-semibold text-gray-800 mb-2">
      {label}
      {required && <span className="text-[#C10007] ml-0.5">*</span>}
    </label>
    {children}
  </div>
);

export default EditDealModal;
