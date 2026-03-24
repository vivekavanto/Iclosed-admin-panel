"use client";

import React, { useState } from "react";
import { X, Plus, Loader2, Save } from "lucide-react";

type LeadType = "Purchase" | "Sale" | "Refinance" | "Status Certificate Review";

interface StageFormData {
  name: string;
  description: { short: string; modal: string; task: string };
  lead_type: LeadType;
  order_index: number;
  role: string;
  is_shared: boolean;
  email_template_id: string;
}

interface EditStageData {
  id: string;
  name: string;
  description: { short?: string; modal?: string; task?: string } | null;
  lead_type: string;
  order_index: number;
  role: string;
  is_shared?: boolean;
  email_template_id: string | null;
}

interface StageTemplateFormModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (result: any) => void;
  emailTemplates: { id: string; name: string }[];
  defaultLeadType?: LeadType;
  defaultOrderIndex?: number;
  hideLeadType?: boolean;
  /** Pass existing stage data to enable edit mode */
  editData?: EditStageData | null;
}

const INITIAL_FORM: StageFormData = {
  name: "",
  description: { short: "", modal: "", task: "" },
  lead_type: "Purchase",
  order_index: 1,
  role: "Client",
  is_shared: false,
  email_template_id: "",
};

export default function StageTemplateFormModal({
  open,
  onClose,
  onCreated,
  emailTemplates,
  defaultLeadType,
  defaultOrderIndex,
  hideLeadType = false,
  editData = null,
}: StageTemplateFormModalProps) {
  const isEditMode = !!editData;

  const [form, setForm] = useState<StageFormData>(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);

  React.useEffect(() => {
    if (open) {
      if (editData) {
        setForm({
          name: editData.name,
          description: {
            short: editData.description?.short ?? "",
            modal: editData.description?.modal ?? "",
            task: editData.description?.task ?? "",
          },
          lead_type: editData.lead_type as LeadType,
          order_index: editData.order_index,
          role: editData.role,
          is_shared: editData.is_shared ?? false,
          email_template_id: editData.email_template_id ?? "",
        });
      } else {
        setForm({
          ...INITIAL_FORM,
          lead_type: defaultLeadType ?? "Purchase",
          order_index: defaultOrderIndex ?? 1,
        });
      }
    }
  }, [open, editData, defaultLeadType, defaultOrderIndex]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return;

    setSubmitting(true);
    try {
      const method = isEditMode ? "PUT" : "POST";
      const payload = isEditMode
        ? { id: editData!.id, ...form, email_template_id: form.email_template_id || null }
        : { ...form, email_template_id: form.email_template_id || null };

      const res = await fetch("/api/admin/milestone-templates", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `Failed to ${isEditMode ? "update" : "create"}`);
      }

      const result = await res.json();
      onCreated(result);
      onClose();
    } catch (err: any) {
      alert(err.message || `Failed to ${isEditMode ? "update" : "create"} stage template`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200">
          <h3 className="text-lg font-bold text-slate-900">
            {isEditMode ? "Edit Stage Template" : "Add Stage Template"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={20} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-4 sm:px-6 py-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Stage Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
              placeholder="e.g. Initial Call"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Short Description</label>
            <input
              type="text"
              value={form.description.short}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, short: e.target.value } }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
              placeholder="Brief one-line description..."
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Modal Description</label>
            <textarea
              value={form.description.modal}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, modal: e.target.value } }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary resize-none"
              placeholder="Description shown in the modal..."
              rows={3}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Task Description</label>
            <textarea
              value={form.description.task}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, task: e.target.value } }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary resize-none"
              placeholder="Description for the task view..."
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!hideLeadType && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Lead Type *</label>
                <select
                  value={form.lead_type}
                  onChange={(e) => setForm((p) => ({ ...p, lead_type: e.target.value as LeadType }))}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                >
                  <option value="Purchase">Purchase</option>
                  <option value="Sale">Sale</option>
                  <option value="Refinance">Refinance</option>
                  <option value="Status Certificate Review">Status Certificate Review</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Order</label>
              <input
                type="number"
                value={form.order_index}
                onChange={(e) => setForm((p) => ({ ...p, order_index: parseInt(e.target.value) || 1 }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                min={1}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
              >
                <option value="Client">Client</option>
                <option value="Lender">Lender</option>
                <option value="Realtor">Realtor</option>
                <option value="Mortgage Agent">Mortgage Agent</option>
                <option value="Opposing Counsel">Opposing Counsel</option>
              </select>
            </div>
            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_shared}
                  onChange={(e) => setForm((p) => ({ ...p, is_shared: e.target.checked }))}
                  className="rounded border-slate-300"
                />
                Shared with client
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">Email Template</label>
            <select
              value={form.email_template_id}
              onChange={(e) => setForm((p) => ({ ...p, email_template_id: e.target.value }))}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
            >
              <option value="">None</option>
              {emailTemplates.map((et) => (
                <option key={et.id} value={et.id}>{et.name}</option>
              ))}
            </select>
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
              {submitting ? (
                <Loader2 size={16} className="animate-spin" />
              ) : isEditMode ? (
                <Save size={16} />
              ) : (
                <Plus size={16} />
              )}
              {submitting ? (isEditMode ? "Saving..." : "Creating...") : isEditMode ? "Save Changes" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
