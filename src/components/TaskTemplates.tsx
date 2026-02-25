"use client";

import React, { useState } from 'react';
import { 
  Search, 
  Plus, 
  CheckCircle2, 
  XCircle, 
  ClipboardList, 
  ArrowUpDown,
  ListTodo
} from 'lucide-react';

interface TaskTemplate {
  id: string;
  leadType: string;
  roleType: string;
  name: string;
  order: number;
  deadlineRule: string;
  isApsTask: boolean;
}

const MOCK_TASK_TEMPLATES: TaskTemplate[] = [
  { id: 'tt1', leadType: 'Purchase', roleType: 'Client', name: 'Upload Complete Agreement of Purchase and Sale and Amendments', order: 1, deadlineRule: 'N business days after task creation', isApsTask: true },
  { id: 'tt2', leadType: 'Purchase', roleType: 'Client', name: 'Provide Personal Information', order: 2, deadlineRule: 'N days before lead closing date', isApsTask: false },
  { id: 'tt3', leadType: 'Purchase', roleType: 'Client', name: 'Upload Identification', order: 3, deadlineRule: 'N days before lead closing date', isApsTask: false },
  { id: 'tt4', leadType: 'Purchase', roleType: 'Client', name: 'Status of Mortgage', order: 4, deadlineRule: 'N days before lead closing date', isApsTask: false },
  { id: 'tt5', leadType: 'Purchase', roleType: 'Client', name: 'Upload Home Insurance Policy', order: 5, deadlineRule: 'N days before lead closing date', isApsTask: false },
  { id: 'tt6', leadType: 'Purchase', roleType: 'Client', name: 'Schedule an Appointment', order: 6, deadlineRule: 'N days before lead closing date', isApsTask: false },
];

const TaskTemplates: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const filteredTasks = MOCK_TASK_TEMPLATES.filter(task => 
    task.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    task.leadType.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header Section */}
      <div className="flex justify-between items-start">
        <div className="flex items-start gap-4">
          <div className="bg-brand-primary/10 p-2.5 rounded-lg">
            <ClipboardList className="text-brand-primary" size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">Task Templates</h1>
            <p className="text-sm text-slate-500 mt-1">
              Manage granular checklist items, deadline logic, and document requirements.
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="relative w-72">
            <input 
              type="text" 
              placeholder="Search tasks..." 
              className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all shadow-sm"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          </div>
          <button className="bg-brand-primary text-white p-2.5 rounded-xl shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95">
            <Plus size={24} />
          </button>
        </div>
      </div>

      {/* Table Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50/50 border-b border-slate-100">
            <tr className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              <th className="px-6 py-5">
                <div className="flex items-center gap-2">
                  <span>Lead Type</span>
                  <ArrowUpDown size={12} className="text-slate-300" />
                  <span className="bg-slate-200/60 text-slate-400 px-1.5 py-0.5 rounded text-[9px] font-black">1</span>
                </div>
              </th>
              <th className="px-6 py-5">
                <div className="flex items-center gap-2">
                  <span>Role Type</span>
                  <ArrowUpDown size={12} className="text-slate-300" />
                  <span className="bg-slate-200/60 text-slate-400 px-1.5 py-0.5 rounded text-[9px] font-black">2</span>
                </div>
              </th>
              <th className="px-6 py-5">Name</th>
              <th className="px-6 py-5">
                <div className="flex items-center gap-2">
                  <span>Order</span>
                  <ArrowUpDown size={12} className="text-slate-300" />
                  <span className="bg-slate-200/60 text-slate-400 px-1.5 py-0.5 rounded text-[9px] font-black">3</span>
                </div>
              </th>
              <th className="px-6 py-5">Deadline Rule</th>
              <th className="px-6 py-5 text-center">Is Upload APS Task</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredTasks.map((task) => (
              <tr key={task.id} className="hover:bg-slate-50/50 transition-colors">
                <td className="px-6 py-5 font-bold text-brand-primary">
                  {task.leadType}
                </td>
                <td className="px-6 py-5 text-slate-600 font-medium">
                  {task.roleType}
                </td>
                <td className="px-6 py-5">
                  <span className="font-bold text-slate-800 leading-tight block max-w-md">
                    {task.name}
                  </span>
                </td>
                <td className="px-6 py-5 text-slate-600 font-medium">
                  {task.order}
                </td>
                <td className="px-6 py-5 italic text-slate-500 font-medium">
                  {task.deadlineRule}
                </td>
                <td className="px-6 py-5 text-center">
                  <div className="flex justify-center">
                    {task.isApsTask ? (
                      <div className="text-green-500 bg-green-50 p-1 rounded-full">
                        <CheckCircle2 size={20} />
                      </div>
                    ) : (
                      <div className="text-brand-primary bg-brand-light p-1 rounded-full">
                        <XCircle size={20} />
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filteredTasks.length === 0 && (
              <tr>
                <td colSpan={6} className="px-6 py-12 text-center text-slate-400 italic">
                  No task templates found.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {/* Footer Action */}
        <div className="p-6 bg-white flex justify-end">
          <button className="bg-brand-primary text-white px-6 py-3 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all hover:scale-[1.02] active:scale-95">
            <Plus size={18} />
            Create new task
          </button>
        </div>
      </div>
    </div>
  );
};

export default TaskTemplates;
