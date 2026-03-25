"use client";

import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  Search,
  FileStack,
  Mail,
  CheckCircle2,
  XCircle,
  Plus,
  Loader2,
  Trash2
} from 'lucide-react';
import StageTemplateFormModal from "@/components/shared/StageTemplateFormModal";

interface StageTemplate {
  id: string;
  name: string;
  lead_type: LeadType;
  order_index: number;
  role: string;
  is_shared: boolean;
  email_template_id: string | null;
  email_templates: { id: string; name: string } | null;
}

interface EmailTemplate {
  id: string;
  name: string;
}

type LeadType = 'Purchase' | 'Sale' | 'Refinance' | 'Status Certificate Review';

interface TemplateSection {
  title: string;
  type: LeadType;
  items: StageTemplate[];
}

const SECTION_TYPES: { title: string; type: LeadType }[] = [
  { title: 'Purchase Template', type: 'Purchase' },
  { title: 'Sale Template', type: 'Sale' },
  { title: 'Refinance Template', type: 'Refinance' },
  { title: 'Status Certificate Review Template', type: 'Status Certificate Review' },
];

const Templates: React.FC = () => {
  const [expandedSections, setExpandedSections] = useState<string[]>(['Purchase']);
  const [searchTerm, setSearchTerm] = useState('');
  const [stageTemplates, setStageTemplates] = useState<StageTemplate[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      const [stageRes, emailRes] = await Promise.all([
        fetch('/api/admin/milestone-templates'),
        fetch('/api/admin/email-templates'),
      ]);
      const stages = await stageRes.json();
      const emails = await emailRes.json();
      setStageTemplates(Array.isArray(stages) ? stages : []);
      setEmailTemplates(Array.isArray(emails) ? emails : []);
    } catch {
      showToast('Failed to load templates', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  const toggleSection = (type: string) =>
    setExpandedSections(prev => prev.includes(type) ? prev.filter(s => s !== type) : [...prev, type]);

  const sections: TemplateSection[] = SECTION_TYPES.map(s => ({
    ...s,
    items: stageTemplates
      .filter(t => t.lead_type === s.type)
      .sort((a, b) => a.order_index - b.order_index),
  }));

  const filteredSections = sections.map(section => ({
    ...section,
    items: section.items.filter(item =>
      item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (item.email_templates?.name && item.email_templates.name.toLowerCase().includes(searchTerm.toLowerCase()))
    ),
  }));

  const handleStageCreated = () => {
    showToast('Stage template created successfully');
    fetchData();
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete stage template "${name}"?`)) return;

    try {
      const res = await fetch(`/api/admin/milestone-templates?id=${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to delete');
      }
      showToast('Stage template deleted');
      fetchData();
    } catch (err: any) {
      showToast(err.message || 'Failed to delete', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-6 right-6 z-50 px-4 py-3 rounded-lg shadow-lg text-sm font-medium text-white ${toast.type === 'success' ? 'bg-green-500' : 'bg-red-500'}`}>
          {toast.message}
        </div>
      )}

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center">
            <FileStack className="mr-3 text-brand-primary" size={28} />
            Stage Templates
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Configure standardized milestones, email triggers, and client sharing for Nava Wilson files.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative w-full md:w-80">
            <input
              type="text"
              placeholder="Search tasks or emails..."
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary transition-colors bg-white shadow-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search className="absolute left-3 top-2.5 text-slate-400" size={18} />
          </div>
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors shadow-sm whitespace-nowrap"
          >
            <Plus size={16} /> Add Stage
          </button>
        </div>
      </div>

      {/* Shared Stage Template Form Modal */}
      <StageTemplateFormModal
        open={showAddForm}
        onClose={() => setShowAddForm(false)}
        onCreated={handleStageCreated}
        emailTemplates={emailTemplates}
      />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-brand-primary" />
          <span className="ml-3 text-sm text-slate-500">Loading templates...</span>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredSections.map((section) => {
            const isExpanded = expandedSections.includes(section.type);
            return (
              <div key={section.type} className="rounded-xl overflow-hidden shadow-sm border border-slate-200 bg-white">
                <button
                  onClick={() => toggleSection(section.type)}
                  className={`w-full flex items-center justify-between px-6 py-5 transition-all duration-300 group ${
                    isExpanded ? 'bg-brand-primary text-white' : 'bg-white text-slate-800 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className={`w-8 h-8 rounded flex items-center justify-center font-bold text-sm ${
                      isExpanded ? 'bg-white/20' : 'bg-brand-primary/10 text-brand-primary'
                    }`}>
                      {section.type[0]}
                    </div>
                    <span className="font-bold text-lg tracking-tight">{section.title}</span>
                    <span className={`text-xs font-medium ${isExpanded ? 'text-white/70' : 'text-slate-400'}`}>
                      ({section.items.length} stages)
                    </span>
                  </div>
                  <ChevronDown size={24} className={`transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
                </button>

                <div className={`transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[2500px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'}`}>
                  <div className="overflow-x-auto">
                    {section.items.length === 0 ? (
                      <p className="text-sm text-slate-400 text-center py-8">No stage templates for this type.</p>
                    ) : (
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                            <th className="px-6 py-3 w-16 text-center">Order</th>
                            <th className="px-6 py-3">Stage Name</th>
                            <th className="px-6 py-3">Role</th>
                            <th className="px-6 py-3">Email Template</th>
                            <th className="px-6 py-3 text-center">Shared</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {section.items.map((item) => (
                            <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-6 py-4 text-center font-mono text-xs text-slate-400">{item.order_index}</td>
                              <td className="px-6 py-4 font-bold text-slate-800">{item.name}</td>
                              <td className="px-6 py-4">
                                <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-tight ${item.role === 'Lender' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                  {item.role}
                                </span>
                              </td>
                              <td className="px-6 py-4">
                                {item.email_templates?.name ? (
                                  <div className="flex items-center gap-2 text-brand-primary font-medium text-xs">
                                    <Mail size={14} />
                                    <span className="underline decoration-dotted">{item.email_templates.name}</span>
                                  </div>
                                ) : <span className="text-slate-300">&mdash;</span>}
                              </td>
                              <td className="px-6 py-4 text-center">
                                {item.is_shared ? <CheckCircle2 className="mx-auto text-green-500" size={16} /> : <XCircle className="mx-auto text-slate-200" size={16} />}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default Templates;
