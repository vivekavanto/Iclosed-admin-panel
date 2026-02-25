"use client";

import React, { useState } from 'react';
import { Search, Plus, Mail, CheckCircle2, Clock, Code2, Info, Copy, Check, ChevronDown } from 'lucide-react';

interface EmailTemplate {
  id: string;
  name: string;
  isActive: boolean;
  createdAt: string;
}

const MOCK_EMAIL_TEMPLATES: EmailTemplate[] = [
  { id: '1', name: 'Aligned with Seller -> Closing Date Coordination Completed Email', isActive: true, createdAt: 'Nov. 12, 2025, 2:11 p.m.' },
  { id: '2', name: 'Financial Info Confirmed -> Mortgage Details Confirmed Email Completed', isActive: true, createdAt: 'Nov. 12, 2025, 2:13 p.m.' },
  { id: '3', name: 'Financing Firm -> Mortgage Instructions Completed Email', isActive: true, createdAt: 'Nov. 12, 2025, 2:07 p.m.' },
  { id: '4', name: 'Initial Intake Completed Email', isActive: true, createdAt: 'Nov. 12, 2025, 2:00 p.m.' },
  { id: '5', name: 'Title Search Completed Email', isActive: true, createdAt: 'Nov. 12, 2025, 2:03 p.m.' },
  { id: '6', name: 'Transaction Completed Email', isActive: true, createdAt: 'Nov. 12, 2025, 2:15 p.m.' },
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

  const handleCopy = (key: string) => {
    navigator.clipboard.writeText(key);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const filteredTemplates = MOCK_EMAIL_TEMPLATES.filter(t => 
    t.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header Section */}
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
          <button className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap">
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
                      <span className="text-sm">{template.createdAt}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredTemplates.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-12 py-20 text-center text-slate-400 flex flex-col items-center">
                    <Mail size={48} className="text-slate-100 mb-4" />
                    <p className="font-medium text-lg">No email templates found matching your search.</p>
                    <button className="text-brand-primary text-sm font-bold mt-2 hover:underline">Create your first template</button>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Sidebar Reference */}
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
                      <code className="text-[13px] font-mono text-slate-900 font-bold bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-inner">
                        {v.key}
                      </code>
                      <button 
                        onClick={() => handleCopy(v.key)} 
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-tight transition-all border shrink-0 ${
                          copiedKey === v.key 
                            ? 'bg-green-500 text-white border-green-500' 
                            : 'bg-white text-slate-500 border-slate-200 hover:border-brand-primary hover:text-brand-primary shadow-sm'
                        }`}
                      >
                        {copiedKey === v.key ? <Check size={12} /> : <Copy size={12} />}
                        {copiedKey === v.key ? 'Copied' : 'Copy Tag'}
                      </button>
                    </div>
                    <span className="text-xs text-slate-500 font-medium">{v.description}</span>
                  </div>
                ))}
              </div>
              
              <div className="mt-8 p-5 bg-brand-light/20 rounded-2xl border border-brand-primary/10 flex gap-4">
                 <Info size={20} className="text-brand-primary shrink-0 mt-0.5" />
                 <p className="text-xs text-slate-600 leading-relaxed font-medium">
                    Click the <span className="text-brand-primary font-black">COPY TAG</span> button next to a variable to use it in your templates.
                 </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmailTemplates;
