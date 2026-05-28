"use client";

import { useCallback, useEffect, useState } from "react";
import {
  X,
  Copy,
  FileText,
  Calendar,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import Button from "@/components/ui/Button";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";

interface ClonePreviousDealDrawerProps {
  open: boolean;
  onClose: () => void;
  leadId: string | null;
  onApplied?: () => void;
}

interface Candidate {
  lead_id: string;
  deal_file_number: string | null;
  deal_type: string | null;
  opening_date: string | null;
  created_at: string | null;
  doc_count: number;
  snapshot: {
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    address_street: string | null;
    address_unit: string | null;
    address_city: string | null;
    address_province: string | null;
    address_postal_code: string | null;
    citizenship_status: string | null;
  };
}

const formatDate = (iso: string | null): string => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return iso;
  }
};

const composeAddress = (s: Candidate["snapshot"]): string => {
  return [
    [s.address_street, s.address_unit].filter(Boolean).join(" "),
    s.address_city,
    s.address_province,
    s.address_postal_code,
  ]
    .filter((p) => p && String(p).trim())
    .join(", ");
};

export default function ClonePreviousDealDrawer({
  open,
  onClose,
  leadId,
  onApplied,
}: ClonePreviousDealDrawerProps) {
  const isLargeScreen = useIsLargeScreen();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [copyFields, setCopyFields] = useState(true);
  const [copyDocs, setCopyDocs] = useState(true);
  const [copyResponses, setCopyResponses] = useState(true);
  const [applying, setApplying] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const fetchCandidates = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/leads/${encodeURIComponent(leadId)}/clone-from-previous`,
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to load previous deals");
        setCandidates([]);
      } else {
        setCandidates(data.candidates ?? []);
        if ((data.candidates ?? []).length === 1) {
          setSelectedId(data.candidates[0].lead_id);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => {
    if (open && leadId) {
      setSelectedId(null);
      setExpandedId(null);
      setSuccessMsg(null);
      setError(null);
      void fetchCandidates();
    }
  }, [open, leadId, fetchCandidates]);

  const handleApply = async () => {
    if (!leadId || !selectedId) return;
    if (!copyFields && !copyDocs && !copyResponses) {
      setError("Select at least one option to copy.");
      return;
    }
    setApplying(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await fetch(
        `/api/admin/leads/${encodeURIComponent(leadId)}/clone-from-previous`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceLeadId: selectedId,
            copyFields,
            copyDocs,
            copyResponses,
          }),
        },
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error ?? "Failed to apply clone");
      } else {
        const fields = data.copied_fields?.length ?? 0;
        const docs = data.copied_doc_count ?? 0;
        const responses = data.copied_response_count ?? 0;
        setSuccessMsg(
          `Copied ${fields} field${fields === 1 ? "" : "s"}, ${docs} document${docs === 1 ? "" : "s"}, and ${responses} task response${responses === 1 ? "" : "s"}.`,
        );
        if (onApplied) onApplied();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <>
      <div
        className={[
          "fixed inset-0 z-40 transition-opacity duration-300",
          isLargeScreen ? "bg-black/40 backdrop-blur-sm" : "bg-black/30",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        className={[
          "fixed z-50 bg-white shadow-2xl flex flex-col",
          isLargeScreen
            ? "inset-4 sm:inset-8 md:inset-12 lg:inset-16 xl:inset-20 max-w-3xl max-h-[85vh] mx-auto my-auto rounded-2xl border border-gray-100"
            : "top-0 right-0 h-full w-full max-w-[540px]",
          isLargeScreen
            ? open
              ? "opacity-100 scale-100"
              : "opacity-0 scale-95 pointer-events-none"
            : open
              ? "translate-x-0"
              : "translate-x-full",
          isLargeScreen
            ? "transition-all duration-200 ease-out"
            : "transition-transform duration-300 ease-in-out",
        ].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label="Clone from previous deal"
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <div className="flex-1 min-w-0 pr-4">
            <h2 className="text-base font-bold text-gray-900 leading-snug flex items-center gap-2">
              <Copy size={16} className="text-[#C10007]" />
              Clone from previous deal
            </h2>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              Prefill personal fields and reuse identification documents from a
              prior deal for this client (matched by email).
            </p>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-slate-500 text-sm">
              <Loader2 className="animate-spin mr-2" size={16} />
              Loading previous deals…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
              No previous deals found for this client's email.
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {candidates.map((c) => {
                  const isSelected = selectedId === c.lead_id;
                  const isExpanded = expandedId === c.lead_id;
                  return (
                    <div
                      key={c.lead_id}
                      className={[
                        "rounded-xl border transition-colors",
                        isSelected
                          ? "border-[#C10007] bg-red-50/30"
                          : "border-slate-200 bg-white hover:border-slate-300",
                      ].join(" ")}
                    >
                      <label className="flex items-start gap-3 px-4 py-3 cursor-pointer">
                        <input
                          type="radio"
                          name="clone-candidate"
                          checked={isSelected}
                          onChange={() => setSelectedId(c.lead_id)}
                          className="mt-1 accent-[#C10007]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center gap-1 text-sm font-bold text-slate-900">
                              <FileText size={13} className="text-slate-500" />
                              {c.deal_file_number ?? "(no deal)"}
                            </span>
                            {c.deal_type && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 font-semibold">
                                {c.deal_type}
                              </span>
                            )}
                            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                              <Calendar size={11} />
                              {formatDate(c.opening_date ?? c.created_at)}
                            </span>
                            <span className="text-[11px] text-slate-500">
                              · {c.doc_count} ID doc{c.doc_count === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="text-xs text-slate-600 mt-0.5 truncate">
                            {[c.snapshot.first_name, c.snapshot.last_name]
                              .filter(Boolean)
                              .join(" ") || "(no name)"}
                            {composeAddress(c.snapshot) && (
                              <> · {composeAddress(c.snapshot)}</>
                            )}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            setExpandedId(isExpanded ? null : c.lead_id);
                          }}
                          className="flex-shrink-0 text-slate-400 hover:text-slate-700 p-1"
                          aria-label={isExpanded ? "Hide details" : "Show details"}
                        >
                          {isExpanded ? (
                            <ChevronUp size={16} />
                          ) : (
                            <ChevronDown size={16} />
                          )}
                        </button>
                      </label>
                      {isExpanded && (
                        <div className="px-4 pb-3 pt-1 text-[12px] text-slate-700 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-100">
                          {Object.entries(c.snapshot).map(([k, v]) => (
                            <div key={k} className="flex gap-2">
                              <span className="text-slate-500 font-semibold capitalize min-w-[110px]">
                                {k.replace(/_/g, " ")}
                              </span>
                              <span className="text-slate-800 truncate">
                                {v || "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3 space-y-2">
                <div className="text-xs font-bold text-slate-700">
                  What to copy
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={copyFields}
                    onChange={(e) => setCopyFields(e.target.checked)}
                    className="accent-[#C10007]"
                  />
                  Personal fields (name, phone, address, citizenship)
                  <span className="text-[11px] text-slate-500">
                    · only fills blanks on the current lead
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={copyDocs}
                    onChange={(e) => setCopyDocs(e.target.checked)}
                    className="accent-[#C10007]"
                  />
                  Identification documents
                  <span className="text-[11px] text-slate-500">
                    · skips slots that already have a doc
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={copyResponses}
                    onChange={(e) => setCopyResponses(e.target.checked)}
                    className="accent-[#C10007]"
                  />
                  Task responses (employment, personal info, etc.)
                  <span className="text-[11px] text-slate-500">
                    · matched by task template; skips fields already answered
                  </span>
                </label>
              </div>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          {successMsg && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <CheckCircle2 size={14} className="flex-shrink-0 mt-0.5" />
              <span>{successMsg}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-gray-100 bg-gray-50/60">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={applying}>
            {successMsg ? "Close" : "Cancel"}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={!selectedId || applying || !!successMsg}
            loading={applying}
          >
            Apply
          </Button>
        </div>
      </div>
    </>
  );
}
