"use client";

import React, { useState } from 'react';
import { 
  ChevronDown, 
  FileText, 
  Download, 
  Edit3, 
  Search,
  FileStack,
  Info,
  Mail,
  CheckCircle2,
  XCircle,
  MoreVertical
} from 'lucide-react';

interface WorkflowItem {
  id: string;
  order: number;
  name: string;
  emailTemplate?: string;
  isShared: boolean;
  role: string;
}

interface TemplateSection {
  title: string;
  type: 'Purchase' | 'Sale' | 'Refinance';
  items: WorkflowItem[];
}

const PURCHASE_WORKFLOW: WorkflowItem[] = [
  { id: '1', order: 1, name: 'Agreement of Purchase and Sale', role: 'Client', isShared: true },
  { id: '2', order: 2, name: 'Initial Call', role: 'Client', emailTemplate: 'Initial Intake Completed Email', isShared: true },
  { id: '3', order: 3, name: 'Personal Information', role: 'Client', isShared: false },
  { id: '4', order: 4, name: 'Identification', role: 'Client', isShared: false },
  { id: '5', order: 5, name: 'Title Search', role: 'Client', emailTemplate: 'Title Search Completed Email', isShared: true },
  { id: '6', order: 6, name: 'Financing Firm → Mortgage Instructions', role: 'Client', emailTemplate: 'Financing Firm → Mortgage Instructions Completed Email', isShared: true },
  { id: '7', order: 7, name: 'Aligned with Seller → Closing Date Coordination', role: 'Client', emailTemplate: 'Aligned with Seller → Closing Date Coordination Completed Email', isShared: true },
  { id: '8', order: 8, name: 'Financial Info Confirmed → Mortgage Details Confirmed', role: 'Client', emailTemplate: 'Financial Info Confirmed → Mortgage Details Confirmed Email Completed', isShared: true },
  { id: '9', order: 9, name: 'Home Insurance', role: 'Client', isShared: false },
  { id: '10', order: 10, name: 'Appointment Scheduled', role: 'Client', isShared: false },
  { id: '11', order: 11, name: 'Documents Signed', role: 'Client', isShared: false },
  { id: '12', order: 12, name: 'Funds received', role: 'Client', isShared: false },
  { id: '14', order: 14, name: 'Transaction Completed', role: 'Client', emailTemplate: 'Transaction Completed Email', isShared: true },
  { id: '15', order: 15, name: 'Final Report Received', role: 'Client', isShared: false },
];

const SALE_WORKFLOW: WorkflowItem[] = [
  { id: 's1', order: 1, name: 'Agreement of Purchase and Sale', role: 'Client', isShared: true },
  { id: 's2', order: 2, name: 'Initial Call & Email', role: 'Client', isShared: true },
  { id: 's3', order: 3, name: 'Financial Info Confirmed & Preparation of Documents', role: 'Client', isShared: true },
  { id: 's4', order: 4, name: 'Documents Signing', role: 'Client', isShared: true },
  { id: 's5', order: 5, name: 'Funds Received', role: 'Client', isShared: true },
  { id: 's6', order: 6, name: 'Transaction Completed', role: 'Client', isShared: false },
];

const REFINANCE_WORKFLOW: WorkflowItem[] = [
  { id: 'r1', order: 1, name: 'Financing -> Mortgage Instructions & Review of Mortgage Terms', role: 'Client', isShared: false },
  { id: 'r2', order: 2, name: 'Title Search', role: 'Client', isShared: false },
  { id: 'r3', order: 3, name: 'Initial Call & Intake Email', role: 'Client', isShared: false },
  { id: 'r4', order: 4, name: 'Review of Documents provided by you & Follow up for any outstanding documents', role: 'Client', isShared: false },
  { id: 'r5', order: 5, name: 'Documents Signed -> Signing Documents', role: 'Client', isShared: false },
  { id: 'r6', order: 6, name: 'Review/Upload Documents to the Lender to obtain file complete', role: 'Client', isShared: false },
  { id: 'r7', order: 7, name: 'Financial Info Confirmed -> Mortgage Details Confirmed', role: 'Client', isShared: false },
  { id: 'r8', order: 8, name: 'Closing Day', role: 'Client', isShared: false },
  { id: 'r9', order: 9, name: 'Final Report', role: 'Client', isShared: false },
  { id: 'r10', order: 1, name: 'Mortgage Instructions Initiated', role: 'Lender', isShared: false },
  { id: 'r11', order: 2, name: 'Borrowers Documents Requested', role: 'Lender', isShared: false },
  { id: 'r12', order: 3, name: 'Review of Borrowers Stage 1 Documents', role: 'Lender', isShared: false },
  { id: 'r13', order: 4, name: 'Signing Documents Sent to Borrowers Lawyer', role: 'Lender', isShared: false },
  { id: 'r14', order: 5, name: 'Stage 2 Documents Received and Verified', role: 'Lender', isShared: false },
  { id: 'r15', order: 6, name: 'Funds Release by the Lender', role: 'Lender', isShared: false },
  { id: 'r16', order: 7, name: 'Deal completed (Funding For refinance)', role: 'Lender', isShared: false },
  { id: 'r17', order: 8, name: 'Deal completed (Funding For Refinance)', role: 'Lender', isShared: false },
];

const MOCK_SECTIONS: TemplateSection[] = [
  { title: 'Purchase Template', type: 'Purchase', items: PURCHASE_WORKFLOW },
  { title: 'Sale Template', type: 'Sale', items: SALE_WORKFLOW },
  { title: 'Refinance Template', type: 'Refinance', items: REFINANCE_WORKFLOW }
];

const Templates: React.FC = () => {
  const [expandedSections, setExpandedSections] = useState<string[]>(['Purchase']);
  const [searchTerm, setSearchTerm] = useState('');
  const toggleSection = (title: string) => setExpandedSections(prev => prev.includes(title) ? prev.filter(s => s !== title) : [...prev, title]);
  const filteredSections = MOCK_SECTIONS.map(section => ({ ...section, items: section.items.filter(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()) || (item.emailTemplate && item.emailTemplate.toLowerCase().includes(searchTerm.toLowerCase()))) }));

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center">
            <FileStack className="mr-3 text-brand-primary" size={28} />
            Workflow Templates
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Configure standardized milestones, email triggers, and client sharing for Nava Wilson files.
          </p>
        </div>
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
      </div>

      <div className="space-y-4">
        {filteredSections.map((section) => {
          const isExpanded = expandedSections.includes(section.type);
          return (
            <div key={section.title} className="rounded-xl overflow-hidden shadow-sm border border-slate-200 bg-white">
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
                </div>
                <ChevronDown size={24} className={`transition-transform duration-300 ${isExpanded ? 'rotate-180' : ''}`} />
              </button>

              <div className={`transition-all duration-300 ease-in-out ${isExpanded ? 'max-h-[2500px] opacity-100' : 'max-h-0 opacity-0 overflow-hidden'}`}>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <th className="px-6 py-3 w-16 text-center">Order</th>
                        <th className="px-6 py-3">Task Name</th>
                        <th className="px-6 py-3">Role</th>
                        <th className="px-6 py-3">Email Template</th>
                        <th className="px-6 py-3 text-center">Shared</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {section.items.map((item) => (
                        <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-6 py-4 text-center font-mono text-xs text-slate-400">{item.order}</td>
                          <td className="px-6 py-4 font-bold text-slate-800">{item.name}</td>
                          <td className="px-6 py-4">
                            <span className={`px-2 py-1 rounded text-[10px] font-bold uppercase tracking-tight ${item.role === 'Lender' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-500'}`}>
                              {item.role}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            {item.emailTemplate ? (
                              <div className="flex items-center gap-2 text-brand-primary font-medium text-xs">
                                <Mail size={14} />
                                <span className="underline decoration-dotted">{item.emailTemplate}</span>
                              </div>
                            ) : <span className="text-slate-300">—</span>}
                          </td>
                          <td className="px-6 py-4 text-center">
                            {item.isShared ? <CheckCircle2 className="mx-auto text-green-500" size={16} /> : <XCircle className="mx-auto text-slate-200" size={16} />}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default Templates;
