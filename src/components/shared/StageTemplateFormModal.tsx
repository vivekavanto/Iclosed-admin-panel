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
  auto_complete: boolean;
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
  auto_complete?: boolean;
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
  auto_complete: false,
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
          auto_complete: editData.auto_complete ?? false,
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isEditMode ? "Edit Stage Template" : "Add Stage Template"}
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
              {isEditMode ? "Edit Stage Template" : "Add Stage Template"}
            </h3>
            <p className="text-xs text-gray-400 mt-1">
              {isEditMode ? "Update this milestone stage template." : "Define a milestone stage for your workflow."}
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
            <label className="block text-sm font-semibold text-gray-800 mb-2">Stage Name <span className="text-[#C10007]">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              placeholder="e.g. Initial Call"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Short Description</label>
            <input
              type="text"
              value={form.description.short}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, short: e.target.value } }))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              placeholder="Brief one-line description..."
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Modal Description</label>
            <textarea
              value={form.description.modal}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, modal: e.target.value } }))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] resize-none"
              placeholder="Description shown in the modal..."
              rows={3}
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Task Description</label>
            <textarea
              value={form.description.task}
              onChange={(e) => setForm((p) => ({ ...p, description: { ...p.description, task: e.target.value } }))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] resize-none"
              placeholder="Description for the task view..."
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {!hideLeadType && (
              <div>
                <label className="block text-sm font-semibold text-gray-800 mb-2">Lead Type <span className="text-[#C10007]">*</span></label>
                <select
                  value={form.lead_type}
                  onChange={(e) => setForm((p) => ({ ...p, lead_type: e.target.value as LeadType }))}
                  className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                >
                  <option value="Purchase">Purchase</option>
                  <option value="Sale">Sale</option>
                  <option value="Refinance">Refinance</option>
                  <option value="Status Certificate Review">Status Certificate Review</option>
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-2">Order</label>
              <input
                type="number"
                value={form.order_index}
                onChange={(e) => setForm((p) => ({ ...p, order_index: parseInt(e.target.value) || 0 }))}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
                min={0}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-semibold text-gray-800 mb-2">Role</label>
              <select
                value={form.role}
                onChange={(e) => setForm((p) => ({ ...p, role: e.target.value }))}
                className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
              >
                <option value="Client">Client</option>
                <option value="Lender">Lender</option>
                <option value="Realtor">Realtor</option>
                <option value="Mortgage Agent">Mortgage Agent</option>
                <option value="Opposing Counsel">Opposing Counsel</option>
              </select>
            </div>
            <div className="flex flex-col gap-2 pb-1 justify-end">
              <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_shared}
                  onChange={(e) => setForm((p) => ({ ...p, is_shared: e.target.checked }))}
                  className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                />
                Shared with client
              </label>
              <label className="flex items-center gap-2 text-sm text-gray-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.auto_complete}
                  onChange={(e) => setForm((p) => ({ ...p, auto_complete: e.target.checked }))}
                  className="rounded border-gray-300 text-[#C10007] focus:ring-[#C10007]"
                />
                Auto-complete on creation
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-gray-800 mb-2">Email Template</label>
            <select
              value={form.email_template_id}
              onChange={(e) => setForm((p) => ({ ...p, email_template_id: e.target.value }))}
              className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007]"
            >
              <option value="">None</option>
              {emailTemplates.map((et) => (
                <option key={et.id} value={et.id}>{et.name}</option>
              ))}
            </select>
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
              className="flex-1 flex items-center justify-center gap-2 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-50"
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
