import React, { useState } from 'react';
import { Plus, X, ChevronDown, Check, FileText, AlertCircle, Building2, ListTodo, Upload } from 'lucide-react';

const Tasks: React.FC = () => {
  const [activeTask, setActiveTask] = useState<'CORPORATE' | 'OVERVIEW'>('CORPORATE');
  return (
    <div className="max-w-5xl mx-auto space-y-6 animate-in fade-in duration-500 py-4">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-3"><ListTodo className="text-brand-primary" size={32} />Tasks & Compliance</h1>
          <p className="text-slate-500 font-medium">Manage and complete required transaction documentation.</p>
        </div>
        <div className="flex gap-2"><button className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-500 hover:bg-slate-50">Filter by File</button><button className="px-4 py-2 bg-brand-primary text-white rounded-xl text-xs font-bold">Task Settings</button></div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-4 space-y-4"><div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div className="p-4 bg-slate-50 border-b border-slate-100"><h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Ongoing Tasks</h3></div><div className="divide-y divide-slate-50"><button onClick={() => setActiveTask('CORPORATE')} className={`w-full text-left p-4 flex items-start gap-3 transition-colors ${activeTask === 'CORPORATE' ? 'bg-brand-light/20' : 'hover:bg-slate-50'}`}><div className={`p-2 rounded-lg shrink-0 ${activeTask === 'CORPORATE' ? 'bg-brand-primary text-white' : 'bg-slate-100 text-slate-400'}`}><Building2 size={18} /></div><div><h4 className="text-sm font-bold text-slate-900 leading-tight">Upload Corporate Files</h4><p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mt-1">Due in 2 days • #26P-0059</p></div></button></div></div></div>
        <div className="lg:col-span-8"><div className="bg-white rounded-3xl border border-slate-200 shadow-xl overflow-hidden animate-in slide-in-from-right duration-300"><div className="p-8 border-b border-slate-100 flex justify-between items-center"><div className="flex items-center gap-3"><h2 className="text-xl font-bold text-slate-800 leading-none">Upload Corporate Files</h2><div className="w-6 h-6 bg-brand-primary rounded-full flex items-center justify-center text-white"><span className="font-serif italic font-bold text-xs">i</span></div></div><button className="text-slate-300 hover:text-slate-600 transition-colors"><X size={24} /></button></div><div className="p-8 space-y-10"><p className="text-slate-400 font-medium text-[15px] -mt-4">Please upload your corporate legal documents and ensure all coverage requirements are met.</p></div></div></div>
      </div>
    </div>
  );
};

export default Tasks;
