"use client";

import { useCallback, useEffect, useState } from "react";
import { X, ChevronDown, CheckCircle2, Loader2, AlertTriangle, UserCog, IdCard, Lock } from "lucide-react";
import Button from "@/components/ui/Button";
import { useIsLargeScreen } from "@/hooks/useMediaQuery";
import UploadIdentificationDrawer from "@/components/UploadIdentificationDrawer";
import CoPersonPersonalInfoModal from "@/components/CoPersonPersonalInfoModal";

/* ─────────────────────────────────────────────
   ADMIN MULTI-PARTY TASK DRAWER
   One modal that stacks every involved party (primary + co-persons) as an
   accordion for the per-party tasks (Personal Information / Upload
   Identification). Each editable section embeds the existing admin drawer in
   embedded mode; the task is "complete" for the deal only once every party's
   section is done.

   Mirrors the customer portal's MultiPartyTaskDrawer, but is fed by
   /api/admin/family-task-status and honours the family's upload_mode from the
   perspective of the currently-viewed person (`selfLeadId`): a member's section
   is editable only when the mode grants that (can_edit).
───────────────────────────────────────────── */

interface FamilyMember {
  lead_id: string;
  deal_id: string;
  task_id: string | null;
  name: string;
  first_name: string;
  last_name: string;
  role_label: string;
  is_primary: boolean;
  is_self: boolean;
  can_edit: boolean;
  completed: boolean;
  doc_count?: number;
  doc_total?: number;
}

interface FamilyStatus {
  is_id_task: boolean;
  all_completed: boolean;
  completed_count: number;
  total_count: number;
  members: FamilyMember[];
}

interface AdminMultiPartyTaskDrawerProps {
  open: boolean;
  onClose: () => void;
  taskTitle: string;
  /** The task id of the clicked row (any family member's copy). */
  taskId: string | null;
  kind: "personal-info" | "upload-id";
  /** The lead of the deal the admin is viewing — drives upload_mode gating. */
  selfLeadId: string | null;
  /** Auto-expand this person's section on open (e.g. the clicked row's owner). */
  initialLeadId?: string | null;
  /** Called whenever any party's section is saved, so the parent can refresh. */
  onAnyCompleted?: () => void;
}

function initials(first: string, last: string): string {
  return `${(first[0] ?? "").toUpperCase()}${(last[0] ?? "").toUpperCase()}` || "?";
}

export default function AdminMultiPartyTaskDrawer({
  open,
  onClose,
  taskTitle,
  taskId,
  kind,
  selfLeadId,
  initialLeadId,
  onAnyCompleted,
}: AdminMultiPartyTaskDrawerProps) {
  const isLargeScreen = useIsLargeScreen();
  const [status, setStatus] = useState<FamilyStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);

  // Refetch per-party status. `preserveExpanded` keeps the open accordion after
  // a section saves; otherwise it opens `initialLeadId` (if editable) or the
  // first editable incomplete party.
  const fetchStatus = useCallback(
    async (preserveExpanded: boolean) => {
      if (!taskId) return;
      try {
        const url = `/api/admin/family-task-status?task_id=${encodeURIComponent(taskId)}${
          selfLeadId ? `&self_lead_id=${encodeURIComponent(selfLeadId)}` : ""
        }`;
        const res = await fetch(url, { cache: "no-store" });
        const data = await res.json();
        if (data.success) {
          setStatus(data as FamilyStatus);
          const members = data.members as FamilyMember[];
          const preferred = initialLeadId
            ? members.find((m) => m.lead_id === initialLeadId && m.can_edit && !!m.task_id)
            : undefined;
          const firstEditablePending = members.find((m) => m.can_edit && !!m.task_id && !m.completed);
          const firstEditable = members.find((m) => m.can_edit && !!m.task_id);
          setExpandedLeadId((prev) =>
            preserveExpanded && prev
              ? prev
              : (preferred ?? firstEditablePending ?? firstEditable)?.lead_id ?? null,
          );
        }
      } catch {
        /* surfaced by the empty state below */
      }
    },
    [taskId, selfLeadId, initialLeadId],
  );

  useEffect(() => {
    if (!open || !taskId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setStatus(null);
      setExpandedLeadId(null);
      await fetchStatus(false);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, taskId, fetchStatus]);

  // Escape + scroll lock for the whole modal (embedded sections don't manage these).
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [open, onClose]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const handleSectionSaved = useCallback(async () => {
    onAnyCompleted?.();
    await fetchStatus(false);
  }, [fetchStatus, onAnyCompleted]);

  const members = status?.members ?? [];
  const completedCount = status?.completed_count ?? 0;
  const totalCount = status?.total_count ?? members.length;
  const allDone = !!status?.all_completed && totalCount > 0;
  const pendingNames = members
    .filter((m) => !m.completed)
    .map((m) => m.first_name)
    .filter(Boolean);

  const subtitle =
    kind === "upload-id"
      ? "Upload identification for every party to complete this task."
      : "Fill in the required information for every party to complete this task.";

  function statusChip(m: FamilyMember) {
    if (m.completed) {
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-green-600">
          <CheckCircle2 size={13} strokeWidth={2.2} /> Complete
        </span>
      );
    }
    if (status?.is_id_task) {
      return (
        <span className="text-xs font-semibold text-[#C10007]">
          {m.doc_count ?? 0}/{m.doc_total ?? 2}
        </span>
      );
    }
    return <span className="text-xs font-semibold text-[#C10007]">Pending</span>;
  }

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={[
          "fixed inset-0 z-40 transition-opacity duration-300",
          isLargeScreen ? "bg-black/40 backdrop-blur-sm" : "bg-black/30",
        ].join(" ")}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal / Drawer */}
      <div
        className={[
          "fixed z-50 bg-white shadow-2xl flex flex-col",
          isLargeScreen
            ? "inset-4 sm:inset-8 md:inset-12 lg:inset-16 xl:inset-20 max-w-3xl max-h-[90vh] mx-auto my-auto rounded-2xl border border-gray-100"
            : "top-0 right-0 h-full w-full max-w-[560px]",
        ].join(" ")}
        role="dialog"
        aria-modal="true"
        aria-label={taskTitle}
      >
        {/* Header — icon badge matches the redesigned single-party popups */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 border-b border-gray-100">
          <div className="flex items-center gap-3 min-w-0 pr-4">
            <div className="w-9 h-9 rounded-full bg-[#FEF2F2] flex items-center justify-center text-[#C10007] flex-shrink-0">
              {kind === "upload-id" ? (
                <IdCard size={17} strokeWidth={2} />
              ) : (
                <UserCog size={17} strokeWidth={2} />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-gray-900 leading-snug truncate">{taskTitle}</h2>
              <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer flex-shrink-0 rounded-md p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={22} className="text-gray-300 animate-spin" />
            </div>
          ) : members.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-center">
              <AlertTriangle size={22} className="text-gray-300" />
              <p className="text-sm text-gray-500 font-medium">Couldn&apos;t load the parties for this task.</p>
            </div>
          ) : (
            members.map((m) => {
              const isExpanded = expandedLeadId === m.lead_id;
              const canExpand = m.can_edit && !!m.task_id;
              return (
                <div
                  key={m.lead_id}
                  className={[
                    "rounded-xl border overflow-hidden",
                    m.completed ? "border-green-200" : "border-gray-200",
                  ].join(" ")}
                >
                  {/* Accordion header */}
                  <button
                    type="button"
                    onClick={() =>
                      canExpand ? setExpandedLeadId(isExpanded ? null : m.lead_id) : undefined
                    }
                    className={[
                      "w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors",
                      m.completed ? "bg-green-50" : "bg-[#C10007]/8 hover:bg-[#C10007]/12",
                      canExpand ? "cursor-pointer" : "cursor-default",
                    ].join(" ")}
                  >
                    <div
                      className={[
                        "w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0",
                        m.completed ? "bg-green-600" : "bg-[#C10007]",
                      ].join(" ")}
                    >
                      {initials(m.first_name, m.last_name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-gray-900 truncate">
                        {m.name || "Party"}&apos;s Details
                      </p>
                      <span className="inline-flex mt-1 px-1.5 py-0.5 rounded text-[10px] font-bold border bg-blue-100 text-blue-700 border-blue-200">
                        {m.role_label}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {statusChip(m)}
                      {canExpand ? (
                        <ChevronDown
                          size={16}
                          className={["text-gray-400 transition-transform", isExpanded ? "rotate-180" : ""].join(" ")}
                        />
                      ) : !m.completed ? (
                        <Lock size={13} className="text-gray-400" />
                      ) : null}
                    </div>
                  </button>

                  {/* Shown only when no matching task exists for this person yet. */}
                  {!canExpand && !m.completed && (
                    <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500">
                      No matching task found for this person yet.
                    </div>
                  )}

                  {/* Accordion body — embedded single-party form */}
                  {isExpanded && canExpand && (
                    <div className="border-t border-gray-100">
                      {kind === "upload-id" ? (
                        <UploadIdentificationDrawer
                          embedded
                          open={open}
                          onClose={onClose}
                          taskId={m.task_id ?? undefined}
                          leadId={m.lead_id}
                          onSaved={handleSectionSaved}
                        />
                      ) : (
                        <CoPersonPersonalInfoModal
                          embedded
                          open={open}
                          onClose={onClose}
                          coPerson={{
                            leadId: m.lead_id,
                            dealId: m.deal_id,
                            name: m.name,
                            role: m.role_label,
                          }}
                          onSaved={handleSectionSaved}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        {!loading && members.length > 0 && (
          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between gap-3">
            <p className="text-sm text-gray-500">
              <span className={allDone ? "font-bold text-green-600" : "font-bold text-gray-900"}>
                {completedCount} of {totalCount} complete
              </span>
              {allDone ? (
                <span className="text-green-600"> · All set</span>
              ) : pendingNames.length > 0 ? (
                <span className="text-gray-400"> · {pendingNames.join(" & ")}&apos;s details still needed</span>
              ) : null}
            </p>
            <Button variant={allDone ? "primary" : "secondary"} onClick={onClose}>
              {allDone ? "Done" : "Close"}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
