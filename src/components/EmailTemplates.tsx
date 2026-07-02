"use client";
import React, { useState, useEffect } from "react";
import {
  Search,
  Plus,
  Mail,
  Clock,
  Code2,
  Info,
  Copy,
  Check,
  ChevronDown,
  X,
  Edit,
  Trash2,
} from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string | null;
  body: string;
  is_active: boolean;
  created_at: string;
}

const EMAIL_VARIABLES = [
  { key: "{{ user.first_name }}", description: "Client's first name" },
  { key: "{{ user.last_name }}", description: "Client's last name" },
  { key: "{{ user.get_full_name }}", description: "Client's full name" },
  { key: "{{ first_name }}", description: "Short alias for first name" },
  { key: "{{ last_name }}", description: "Short alias for last name" },
  { key: "{{ full_name }}", description: "Short alias for full name" },
  { key: "{{ email }}", description: "Client's email address" },
  { key: "{{ lead_address }}", description: "Formatted address string" },
  { key: "{{ property_address }}", description: "Short alias for formatted address" },
  { key: "{{ lockbox_code }}", description: "Property lock box code (Purchase files)" },
  { key: "{{ lead.lockbox_code }}", description: "Property lock box code (namespaced form)" },
  { key: "{{ lead.address_line1 }}", description: "Address line 1" },
  { key: "{{ lead.address_city }}", description: "City" },
  { key: "{{ lead.address_province }}", description: "Province" },
  { key: "{{ lead.file_number }}", description: "File number" },
  { key: "{{ file_number }}", description: "Short alias for file number" },
  { key: "{{ side_suffix }}", description: "Subject suffix: '', ' (Sale)', or ' (Purchase & Sale)'" },
  { key: "{{ property_role_row }}", description: "Pre-rendered 'Your Role: Purchaser/Seller/Co-…' line" },
  { key: "{{ stage_name }}", description: "Stage template name" },
  { key: "{{ stage_status }}", description: "Current stage status" },
  { key: "{{ confirmation_url }}", description: "Auth action link (invite / reset password)" },
];

const EmailTemplates: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isVarRefExpanded, setIsVarRefExpanded] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<EmailTemplate | null>(null);

  const [form, setForm] = useState({
    id: "",
    name: "",
    subject: "",
    body: "",
    is_active: true,
  });

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleInsertVariable = (key: string) => {
    setForm((prev) => ({ ...prev, body: prev.body + key }));
  };
  const resetForm = () => {
    setForm({ id: "", name: "", subject: "", body: "", is_active: true });
  };
  const handleDelete = async (template: EmailTemplate) => {
    setDeletingId(template.id);
    try {
      const res = await fetch(
        `/api/admin/email-templates?id=${encodeURIComponent(template.id)}`,
        { method: "DELETE" },
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      setTemplates((prev) => prev.filter((t) => t.id !== template.id));
      setConfirmDelete(null);
    } catch (err: any) {
      console.error("❌ Delete failed:", err.message);
      alert(`Failed to delete template: ${err.message}`);
    } finally {
      setDeletingId(null);
    }
  };

  const handleEdit = (template: EmailTemplate) => {
    setForm({
      id: template.id,
      name: template.name ?? "",
      subject: template.subject ?? "",
      body: template.body ?? "",
      is_active: template.is_active ?? true,
    });
    setIsModalOpen(true);
  };

  useEffect(() => {
    const getTemplates = async () => {
      try {
        const res = await fetch("/api/admin/email-templates");
        const data = await res.json();

        if (!res.ok) {
          console.error("❌ API error:", data?.error);
          setFetchError(data?.error || `HTTP ${res.status}`);
          return;
        }

        console.log("✅ email templates fetched:", data);
        setTemplates(data);
      } catch (err: any) {
        console.error("❌ Fetch failed:", err.message);
        setFetchError(err.message);
      }
    };
    getTemplates();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const method = form.id ? "PUT" : "POST";

      const res = await fetch("/api/admin/email-templates", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error("Failed");

      const result = await res.json();

      if (form.id) {
        // UPDATE
        setTemplates((prev) =>
          prev.map((t) => (t.id === result.id ? result : t)),
        );
      } else {
        // CREATE
        setTemplates((prev) => [result, ...prev]);
      }

      setIsModalOpen(false);
      resetForm();
    } catch (err) {
      alert("Error saving template.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredTemplates = templates.filter((t) =>
    t.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  const inputClasses =
    "w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-800 outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10 transition-all bg-white placeholder:text-slate-300";

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {fetchError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
          <span className="font-black">DB Fetch Error:</span> {fetchError}
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900 flex items-center tracking-tight">
            <Mail className="mr-3 text-brand-primary" size={32} />
            Email Templates
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Manage automated correspondence triggers and merge tag logic for
            client communications.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search templates..."
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all bg-white shadow-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search
              className="absolute left-3 top-3 text-slate-400"
              size={20}
            />
          </div>
          <button
            onClick={() => setIsModalOpen(true)}
            className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={20} />
            New Template
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
        {/* Main List */}
        <div className="xl:col-span-8 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead className="bg-slate-50/30 border-b border-slate-100">
              <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                <th className="px-6 py-5">Name</th>
                <th className="px-4 py-5">Subject</th>
                <th className="px-4 py-5 text-center w-24">Active</th>
                <th className="px-4 py-5 w-40">Created</th>
                <th className="px-4 py-5 text-center w-24">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filteredTemplates.map((template) => (
                <tr
                  key={template.id}
                  className="hover:bg-slate-50/50 transition-colors group"
                >
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 bg-brand-light flex items-center justify-center rounded-lg shrink-0">
                        <Mail className="text-brand-primary" size={16} />
                      </div>
                      <span className="font-bold text-slate-800 text-sm leading-snug">
                        {template.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-xs text-slate-500 truncate block max-w-[200px]">
                      {template.subject || <span className="italic text-slate-300">Uses template name</span>}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className="flex justify-center">
                      {template.is_active ? (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-green-50 text-green-700 ring-1 ring-green-200">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-500 ring-1 ring-slate-200">
                          Inactive
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-4">
                    <span className="text-xs text-slate-400 font-medium">
                      {formatLocalDate(template.created_at) || "—"}
                    </span>
                  </td>
                  <td className="px-4 py-4 text-center">
                    <div className="flex justify-center items-center gap-1">
                      <button
                        onClick={() => handleEdit(template)}
                        className="text-brand-primary hover:text-brand-primaryHover transition-colors p-1"
                        title="Edit template"
                      >
                        <Edit size={18} />
                      </button>
                      <button
                        onClick={() => setConfirmDelete(template)}
                        className="text-slate-400 hover:text-red-600 transition-colors p-1"
                        title="Delete template"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredTemplates.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-12 py-20 text-center text-slate-400"
                  >
                    <Mail size={48} className="text-slate-100 mb-4 mx-auto" />
                    <p className="font-medium text-lg">
                      No email templates found.
                    </p>
                    <button
                      onClick={() => setIsModalOpen(true)}
                      className="text-brand-primary text-sm font-bold mt-2 hover:underline"
                    >
                      Create your first template
                    </button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Sidebar Variable Reference */}
        <div className="xl:col-span-4 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden sticky top-8">
            <button
              onClick={() => setIsVarRefExpanded(!isVarRefExpanded)}
              className="w-full flex items-center justify-between p-6 hover:bg-slate-50/50 transition-colors border-b border-slate-50"
            >
              <div className="flex items-center gap-4">
                <div className="p-2.5 bg-slate-50 text-slate-900 rounded-xl border border-slate-100">
                  <Code2 size={22} />
                </div>
                <div className="text-left">
                  <h3 className="font-bold text-slate-900 text-lg leading-none">
                    Variable Reference
                  </h3>
                  <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1.5">
                    LeadStage Context Tags
                  </p>
                </div>
              </div>
              <ChevronDown
                className={`transition-transform duration-300 text-slate-400 ${isVarRefExpanded ? "rotate-180" : ""}`}
                size={20}
              />
            </button>

            <div
              className={`transition-all duration-300 ${isVarRefExpanded ? "max-h-[2000px] opacity-100 p-6" : "max-h-0 opacity-0 overflow-hidden"}`}
            >
              <div className="space-y-4">
                {EMAIL_VARIABLES.map((v) => (
                  <div
                    key={v.key}
                    className="p-4 rounded-xl border border-slate-100 bg-slate-50/30 hover:bg-white hover:border-brand-primary/20 hover:shadow-sm transition-all group"
                  >
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <code className="text-[13px] font-mono text-slate-900 font-bold bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-inner truncate">
                        {v.key}
                      </code>
                      <button
                        onClick={() => handleCopy(v.key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tight transition-all border shrink-0 ${
                          copiedKey === v.key
                            ? "bg-green-500 text-white border-green-500"
                            : "bg-white text-slate-500 border-slate-200 hover:border-brand-primary hover:text-brand-primary shadow-sm"
                        }`}
                      >
                        {copiedKey === v.key ? (
                          <Check size={12} />
                        ) : (
                          <Copy size={12} />
                        )}
                        {copiedKey === v.key ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <span className="text-xs text-slate-500 font-medium">
                      {v.description}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-8 p-5 bg-brand-light/20 rounded-2xl border border-brand-primary/10 flex gap-4">
                <Info
                  size={20}
                  className="text-brand-primary shrink-0 mt-0.5"
                />
                <p className="text-xs text-slate-600 leading-relaxed font-medium">
                  Click{" "}
                  <span className="text-brand-primary font-black">COPY</span> to
                  copy a tag, then paste it into your template body.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Template Modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={form.id ? "Edit Email Template" : "New Email Template"}
          className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex justify-end items-stretch lg:justify-center lg:items-center bg-black/30 lg:bg-black/40 lg:backdrop-blur-sm lg:p-4 xl:p-12 2xl:p-20 transition-[left] duration-300"
          onClick={() => {
            setIsModalOpen(false);
            resetForm();
          }}
        >
          <div
            className="bg-white shadow-2xl flex flex-col w-full h-full max-w-[520px] slide-in-from-right lg:h-auto lg:max-h-[90vh] lg:max-w-5xl lg:rounded-2xl lg:zoom-in lg:duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-start justify-between px-6 py-5 border-b border-gray-100">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-gray-900">
                  {form.id ? "Edit Email Template" : "New Email Template"}
                </h3>
                <p className="text-xs text-gray-400 mt-1">
                  {form.id
                    ? "Update this email template."
                    : "Create a reusable email template for automated client communications."}
                </p>
              </div>
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  resetForm();
                }}
                className="text-gray-400 hover:text-gray-700 shrink-0 ml-4"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
              {/* Body (scrollable) */}
              <div className="px-6 py-6 space-y-5 overflow-y-auto flex-1">
                {/* Name */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Template Name <span className="text-[#C10007]">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Initial Intake Completed"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                    value={form.name}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, name: e.target.value }))
                    }
                  />
                </div>

                {/* Subject */}
                <div>
                  <label className="text-sm font-semibold text-gray-800 block mb-2">
                    Email Subject
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Your Transaction Update — iClosed"
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white"
                    value={form.subject}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, subject: e.target.value }))
                    }
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    If left empty, the template name will be used as the subject.
                  </p>
                </div>

                {/* Body */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-semibold text-gray-800">
                      Email Body <span className="text-[#C10007]">*</span>
                    </label>
                    <div className="flex flex-wrap gap-1">
                      {EMAIL_VARIABLES.slice(0, 3).map((v) => (
                        <button
                          key={v.key}
                          type="button"
                          onClick={() => handleInsertVariable(v.key)}
                          className="text-[10px] font-semibold uppercase tracking-tight px-2 py-1 bg-gray-100 text-gray-600 hover:bg-[#C10007] hover:text-white rounded-md transition-all"
                        >
                          {v.key.replace(/[{}]/g, "").trim()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea
                    required
                    rows={10}
                    placeholder={`Hi {{ user.first_name }},\n\nYour file {{ lead.file_number }} has been updated...\n\nBest regards,\nNava Wilson`}
                    className="w-full px-4 py-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-[#C10007] focus:ring-1 focus:ring-[#C10007] bg-white resize-none font-mono leading-relaxed"
                    value={form.body}
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, body: e.target.value }))
                    }
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    Use the variable tags above to insert dynamic content into
                    your email.
                  </p>
                </div>

                {/* Is Active Toggle */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div>
                    <p className="text-sm font-semibold text-gray-800">
                      Active Template
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      When active, this template can be triggered automatically
                      by stage milestones.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setForm((prev) => ({ ...prev, is_active: !prev.is_active }))
                    }
                    className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${form.is_active ? "bg-[#C10007]" : "bg-slate-300"}`}
                  >
                    <span
                      className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${form.is_active ? "translate-x-6" : "translate-x-0"}`}
                    />
                  </button>
                </div>
              </div>

              {/* Footer */}
              <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-3 px-6 py-4 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    resetForm();
                  }}
                  className="flex-1 py-3 border border-[#C10007] bg-white text-[#C10007] rounded-lg text-sm font-semibold hover:bg-[#FEF2F2]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 py-3 bg-[#C10007] text-white rounded-lg text-sm font-semibold hover:bg-[#a30006] disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmitting
                    ? "Creating..."
                    : form.id
                      ? "Update Template"
                      : "Create Template"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 md:left-[var(--sidebar-w,256px)] z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-200 transition-[left] duration-300">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => deletingId === null && setConfirmDelete(null)}
          />
          <div className="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md relative z-10 animate-in zoom-in-95 duration-200">
            <div className="p-8">
              <div className="flex items-start gap-4">
                <div className="w-12 h-12 bg-red-50 flex items-center justify-center rounded-xl shrink-0">
                  <Trash2 className="text-red-600" size={22} />
                </div>
                <div className="flex-1">
                  <h3 className="text-xl font-black text-slate-900 leading-tight">
                    Delete Email Template
                  </h3>
                  <p className="text-sm text-slate-500 font-medium mt-2 leading-relaxed">
                    Are you sure you want to delete{" "}
                    <span className="font-bold text-slate-800">
                      “{confirmDelete.name}”
                    </span>
                    ? This template will no longer be available for stage
                    triggers.
                  </p>
                </div>
              </div>

              <div className="flex justify-end gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setConfirmDelete(null)}
                  disabled={deletingId !== null}
                  className="px-6 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(confirmDelete)}
                  disabled={deletingId !== null}
                  className="px-6 py-2.5 bg-red-600 text-white rounded-xl font-bold text-sm shadow-lg shadow-red-600/20 hover:bg-red-700 transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {deletingId === confirmDelete.id ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailTemplates;
