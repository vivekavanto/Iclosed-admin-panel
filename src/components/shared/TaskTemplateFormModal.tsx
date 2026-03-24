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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-900">
            {isEdit ? "Edit Task Template" : "New Task Template"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 sm:px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Task Name *</label>
            <input
              type="text"
              required
              placeholder="e.g. Upload Signed APS"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!hideLeadType && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Lead Type *</label>
                <select
                  required
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
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
              <label className="block text-xs font-semibold text-slate-600 mb-1">Role Type *</label>
              <input
                type="text"
                required
                placeholder="e.g. Client, Agent, Lawyer"
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                value={form.roleType}
                onChange={(e) => setForm((p) => ({ ...p, roleType: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Order *</label>
              <input
                type="number"
                required
                min={1}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                value={form.order}
                onChange={(e) => setForm((p) => ({ ...p, order: parseInt(e.target.value) || 1 }))}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Deadline Rule</label>
              <select
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
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
            <label className="block text-xs font-semibold text-slate-600 mb-1">Stage (Milestone)</label>
            <select
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
              value={form.stageTemplateId}
              onChange={(e) => setForm((p) => ({ ...p, stageTemplateId: e.target.value }))}
            >
              <option value="">No Stage</option>
              {filteredStages.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.isApsTask}
                  onChange={() => setForm((p) => ({ ...p, isApsTask: !p.isApsTask }))}
                  className="rounded border-slate-300"
                />
                APS Task
              </label>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={() => setForm((p) => ({ ...p, is_default: !p.is_default }))}
                  className="rounded border-slate-300"
                />
                Default
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors disabled:opacity-50"
            >
              {submitting ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
