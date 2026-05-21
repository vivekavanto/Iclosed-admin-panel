"use client";

import React, { useState } from "react";
import { X } from "lucide-react";

const LEAD_TYPES = ["Purchase", "Sale", "Refinance"];

const DEADLINE_RULES = [
  "N business days after task creation",
  "N days before lead closing date",
  "N days before lead requisition date",
];

interface TaskFormData {
  id: string;
  leadType: string;
  roleType: string;
  name: string;
  order: number;
  deadlineRule: string;
  isApsTask: boolean;
  is_default: boolean;
  is_shared: boolean;
  stageTemplateId: string;
}

interface TaskTemplateFormModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (result: any, isEdit: boolean) => void;
  stageTemplates: { id: string; name: string; lead_type: string }[];
  /** Pre-fill values for edit mode */
  editData?: {
    id: string;
    leadType: string;
    roleType: string;
    name: string;
    order: number;
    deadlineRule: string | null;
    isApsTask: boolean;
    is_default: boolean;
    is_shared: boolean;
    stageTemplateId: string | null;
  } | null;
  /** Pre-fill lead type (from active tab in DefaultTasks) */
  defaultLeadType?: string;
  /** Pre-fill stage template id */
  defaultStageTemplateId?: string | null;
  /** Hide lead type selector when it's implied by context */
  hideLeadType?: boolean;
}

const EMPTY_FORM: TaskFormData = {
  id: "",
  leadType: "Purchase",
  roleType: "Client",
  name: "",
  order: 1,
  deadlineRule: DEADLINE_RULES[0],
  isApsTask: false,
  is_default: false,
  is_shared: false,
  stageTemplateId: "",
};

export default function TaskTemplateFormModal({
  open,
  onClose,
  onSaved,
  stageTemplates,
  editData,
  defaultLeadType,
  defaultStageTemplateId,
  hideLeadType = false,
}: TaskTemplateFormModalProps) {
  const buildInitialForm = React.useCallback((): TaskFormData => {
    if (editData) {
      return {
        id: editData.id,
        leadType: editData.leadType,
        roleType: editData.roleType,
        name: editData.name,
        order: editData.order,
        deadlineRule: editData.deadlineRule || DEADLINE_RULES[0],
        isApsTask: editData.isApsTask,
        is_default: editData.is_default,
        is_shared: editData.is_shared ?? false,
        stageTemplateId: editData.stageTemplateId || "",
      };
    }
    return {
      ...EMPTY_FORM,
      leadType: defaultLeadType ?? "Purchase",
      stageTemplateId: defaultStageTemplateId ?? "",
    };
  }, [editData, defaultLeadType, defaultStageTemplateId]);

  const [form, setForm] = useState<TaskFormData>(buildInitialForm);
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(buildInitialForm());
    }
  }, [open, buildInitialForm]);

  if (!open) return null;

  const isEdit = !!form.id;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    setSubmitting(true);
    try {
      const method = isEdit ? "PUT" : "POST";
      const res = await fetch("/api/admin/task-templates", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error("Failed to save");

      const result = await res.json();
      onSaved(result, isEdit);
      onClose();
    } catch {
      alert("Error saving task template.");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredStages = stageTemplates.filter((s) => s.lead_type === form.leadType);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? "Edit Task Template" : "New Task Template"}
      className="fixed inset-0 z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20"
      onClick={onClose}
    >
      <div
        className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-gray-900">
              {isEdit ? "Edit Task Template" : "New Task Template"}
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {isEdit ? "Update this task template's details." : "Define a reusable task template for deals."}
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

        <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
          <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Task Name <span className="text-[#C10007]">*</span></label>
            <input
              type="text"
              required
              placeholder="e.g. Upload Signed APS"
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!hideLeadType && (
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-2">Lead Type <span className="text-[#C10007]">*</span></label>
                <select
                  required
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                  value={form.leadType}
                  onChange={(e) => setForm((p) => ({ ...p, leadType: e.target.value }))}
                >
                  {LEAD_TYPES.map((lt) => (
                    <option key={lt} value={lt}>{lt}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-2">Role Type <span className="text-[#C10007]">*</span></label>
              <input
                type="text"
                required
                placeholder="e.g. Client, Agent, Lawyer"
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                value={form.roleType}
                onChange={(e) => setForm((p) => ({ ...p, roleType: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-2">Order <span className="text-[#C10007]">*</span></label>
              <input
                type="number"
                required
                min={1}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                value={form.order}
                onChange={(e) => setForm((p) => ({ ...p, order: parseInt(e.target.value) || 1 }))}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-2">Deadline Rule</label>
              <select
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                value={form.deadlineRule}
                onChange={(e) => setForm((p) => ({ ...p, deadlineRule: e.target.value }))}
              >
                {DEADLINE_RULES.map((rule) => (
                  <option key={rule} value={rule}>{rule}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Stage (Milestone)</label>
            <select
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              value={form.stageTemplateId}
              onChange={(e) => setForm((p) => ({ ...p, stageTemplateId: e.target.value }))}
            >
              <option value="">No Stage</option>
              {filteredStages.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isApsTask}
                  onChange={() => setForm((p) => ({ ...p, isApsTask: !p.isApsTask }))}
                  className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                />
                APS Task
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={() => setForm((p) => ({ ...p, is_default: !p.is_default }))}
                  className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                />
                Default
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_shared}
                  onChange={() => setForm((p) => ({ ...p, is_shared: !p.is_shared }))}
                  className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                />
                Shared (Co-Purchaser)
              </label>
            </div>
          </div>
          </div>

          <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-50"
            >
              {submitting ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
