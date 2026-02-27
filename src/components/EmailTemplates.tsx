"use client";

import React, { useState, useEffect } from 'react';
import { Search, Plus, Mail, CheckCircle2, Clock, Code2, Info, Copy, Check, ChevronDown, X, Toggle } from 'lucide-react';

interface EmailTemplate {
  id: string;
  name: string;
  is_active: boolean;
  created_at: string;
}

const MOCK_EMAIL_TEMPLATES: EmailTemplate[] = [
  { id: '1', name: 'Aligned with Seller -> Closing Date Coordination Completed Email', is_active: true, created_at: 'Nov. 12, 2025, 2:11 p.m.' },
  { id: '2', name: 'Financial Info Confirmed -> Mortgage Details Confirmed Email Completed', is_active: true, created_at: 'Nov. 12, 2025, 2:13 p.m.' },
  { id: '3', name: 'Financing Firm -> Mortgage Instructions Completed Email', is_active: true, created_at: 'Nov. 12, 2025, 2:07 p.m.' },
  { id: '4', name: 'Initial Intake Completed Email', is_active: true, created_at: 'Nov. 12, 2025, 2:00 p.m.' },
  { id: '5', name: 'Title Search Completed Email', is_active: true, created_at: 'Nov. 12, 2025, 2:03 p.m.' },
  { id: '6', name: 'Transaction Completed Email', is_active: true, created_at: 'Nov. 12, 2025, 2:15 p.m.' },
];

const EMAIL_VARIABLES = [
  { key: '{{ user.first_name }}', description: "Client's first name" },
  { key: '{{ user.last_name }}', description: "Client's last name" },
  { key: '{{ user.get_full_name }}', description: "Client's full name" },
  { key: '{{ lead_address }}', description: 'Formatted address string' },
  { key: '{{ lead.address_line1 }}', description: 'Address line 1' },
  { key: '{{ lead.address_city }}', description: 'City' },
  { key: '{{ lead.address_province }}', description: 'Province' },
  { key: '{{ lead.file_number }}', description: 'File number' },
  { key: '{{ stage_name }}', description: 'Stage template name' },
  { key: '{{ stage_status }}', description: 'Current stage status' },
];

const EmailTemplates: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [isVarRefExpanded, setIsVarRefExpanded] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: '',
    body: '',
    is_active: true,
  });

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const handleInsertVariable = (key: string) => {
    setForm(prev => ({ ...prev, body: prev.body + key }));
  };

  const resetForm = () => {
    setForm({ name: '', body: '', is_active: true });
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
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/email-templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, body: form.body, is_active: form.is_active }),
      });

      if (!res.ok) throw new Error('Failed to create template');

      const created = await res.json();
      setTemplates(prev => [created, ...prev]);
      setIsModalOpen(false);
      resetForm();
    } catch (err) {
      alert('Error creating template. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const filteredTemplates = templates.filter(t =>
    t.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const inputClasses = "w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-800 outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10 transition-all bg-white placeholder:text-slate-300";

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
            Manage automated correspondence triggers and merge tag logic for client communications.
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
            <Search className="absolute left-3 top-3 text-slate-400" size={20} />
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
        <div className="xl:col-span-8 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50/30 border-b border-slate-100">
              <tr className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">
                <th className="px-8 py-6">Name</th>
                <th className="px-6 py-6 text-center w-32">Is Active</th>
                <th className="px-8 py-6 w-48">Created At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {filteredTemplates.map((template) => (
                <tr key={template.id} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 bg-brand-light flex items-center justify-center rounded-lg">
                        <Mail className="text-brand-primary" size={18} />
                      </div>
                      <span className="font-bold text-slate-800 text-[15px] leading-snug max-w-md">
                        {template.name}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-6 text-center">
                    <div className="flex justify-center">
                      <div className="text-green-500 bg-green-50 p-1.5 rounded-full ring-1 ring-green-100">
                        <CheckCircle2 size={20} />
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-2 text-slate-400 font-medium">
                      <Clock size={16} className="shrink-0" />
                      <span className="text-sm">{template.created_at}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredTemplates.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-12 py-20 text-center text-slate-400">
                    <Mail size={48} className="text-slate-100 mb-4 mx-auto" />
                    <p className="font-medium text-lg">No email templates found.</p>
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
                  <h3 className="font-bold text-slate-900 text-lg leading-none">Variable Reference</h3>
                  <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-1.5">LeadStage Context Tags</p>
                </div>
              </div>
              <ChevronDown className={`transition-transform duration-300 text-slate-400 ${isVarRefExpanded ? 'rotate-180' : ''}`} size={20} />
            </button>

            <div className={`transition-all duration-300 ${isVarRefExpanded ? 'max-h-[2000px] opacity-100 p-6' : 'max-h-0 opacity-0 overflow-hidden'}`}>
              <div className="space-y-4">
                {EMAIL_VARIABLES.map((v) => (
                  <div key={v.key} className="p-4 rounded-xl border border-slate-100 bg-slate-50/30 hover:bg-white hover:border-brand-primary/20 hover:shadow-sm transition-all group">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <code className="text-[13px] font-mono text-slate-900 font-bold bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-inner truncate">
                        {v.key}
                      </code>
                      <button
                        onClick={() => handleCopy(v.key)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tight transition-all border shrink-0 ${copiedKey === v.key
                          ? 'bg-green-500 text-white border-green-500'
                          : 'bg-white text-slate-500 border-slate-200 hover:border-brand-primary hover:text-brand-primary shadow-sm'
                          }`}
                      >
                        {copiedKey === v.key ? <Check size={12} /> : <Copy size={12} />}
                        {copiedKey === v.key ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <span className="text-xs text-slate-500 font-medium">{v.description}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 p-5 bg-brand-light/20 rounded-2xl border border-brand-primary/10 flex gap-4">
                <Info size={20} className="text-brand-primary shrink-0 mt-0.5" />
                <p className="text-xs text-slate-600 leading-relaxed font-medium">
                  Click <span className="text-brand-primary font-black">COPY</span> to copy a tag, then paste it into your template body.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Create Template Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => { setIsModalOpen(false); resetForm(); }}
          />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl relative z-10 overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-8 border-b border-slate-100 flex justify-between items-start">
              <div>
                <h3 className="text-2xl font-black text-slate-900 leading-none">New Email Template</h3>
                <p className="text-slate-500 font-medium mt-2">Create a reusable email template for automated client communications.</p>
              </div>
              <button
                onClick={() => { setIsModalOpen(false); resetForm(); }}
                className="text-slate-300 hover:text-slate-600 transition-colors mt-1"
              >
                <X size={24} />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleSubmit} className="p-8 space-y-6">

              {/* Name */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Template Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Initial Intake Completed Email"
                  className={inputClasses}
                  value={form.name}
                  onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
              </div>

              {/* Body */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                    Email Body <span className="text-red-500">*</span>
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {EMAIL_VARIABLES.slice(0, 3).map(v => (
                      <button
                        key={v.key}
                        type="button"
                        onClick={() => handleInsertVariable(v.key)}
                        className="text-[9px] font-black uppercase tracking-tight px-2 py-1 bg-slate-100 text-slate-500 hover:bg-brand-primary hover:text-white rounded-md transition-all"
                      >
                        {v.key.replace(/[{}]/g, '').trim()}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  required
                  rows={8}
                  placeholder={`Hi {{ user.first_name }},\n\nYour file {{ lead.file_number }} has been updated...\n\nBest regards,\nNava Wilson`}
                  className={`${inputClasses} resize-none font-mono text-xs leading-relaxed`}
                  value={form.body}
                  onChange={(e) => setForm(prev => ({ ...prev, body: e.target.value }))}
                />
                <p className="text-[10px] text-slate-400 font-medium">
                  Use the variable tags above to insert dynamic content into your email.
                </p>
              </div>

              {/* Is Active Toggle */}
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-100">
                <div>
                  <p className="text-sm font-bold text-slate-800">Active Template</p>
                  <p className="text-xs text-slate-500 font-medium">When active, this template can be triggered automatically by stage milestones.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setForm(prev => ({ ...prev, is_active: !prev.is_active }))}
                  className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${form.is_active ? 'bg-brand-primary' : 'bg-slate-300'}`}
                >
                  <span className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${form.is_active ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => { setIsModalOpen(false); resetForm(); }}
                  className="px-6 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-8 py-2.5 bg-brand-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? 'Creating...' : 'Create Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmailTemplates;
