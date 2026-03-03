"use client";

import React, { useState, useEffect } from "react";
import {
  Search,
  Plus,
  CheckCircle2,
  XCircle,
  ClipboardList,
  ArrowUpDown,
  X,
  Edit,
  Trash2,
} from "lucide-react";

interface TaskTemplate {
  id: string;
  leadType: string;
  roleType: string;
  name: string;
  order: number;
  deadlineRule: string | null;
  isApsTask: boolean;
}

const LEAD_TYPES = ["Purchase", "Sale", "Refinance"];

const emptyForm = {
  id: "",
  leadType: "Purchase",
  roleType: "Client",
  name: "",
  order: 1,
  deadlineRule: "",
  isApsTask: false,
};

const TaskTemplates: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [tasks, setTasks] = useState<TaskTemplate[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });

  const filteredTasks = tasks.filter(
    (task) =>
      task.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.leadType.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  useEffect(() => {
    const fetchTasks = async () => {
      try {
        const res = await fetch("/api/admin/task-templates");
        const data = await res.json();

        if (!res.ok) {
          setFetchError(data?.error || `HTTP ${res.status}`);
          return;
        }

        setTasks(
          data.map((t: any) => ({
            id: t.id,
            leadType: t.lead_type,
            roleType: t.role_type,
            name: t.name,
            order: t.order_index,
            deadlineRule: t.deadline_rule,
            isApsTask: t.is_aps_task,
          })),
        );
      } catch (err: any) {
        setFetchError(err.message);
      }
    };

    fetchTasks();
  }, []);

  const resetForm = () => setForm({ ...emptyForm });

  const handleEdit = (task: TaskTemplate) => {
    setForm({
      id: task.id,
      leadType: task.leadType,
      roleType: task.roleType,
      name: task.name,
      order: task.order,
      deadlineRule: task.deadlineRule || "",
      isApsTask: task.isApsTask,
    });
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this task template?")) return;

    const res = await fetch(`/api/admin/task-templates?id=${id}`, {
      method: "DELETE",
    });

    if (res.ok) {
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } else {
      alert("Failed to delete.");
    }
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const method = form.id ? "PUT" : "POST";

      const res = await fetch("/api/admin/task-templates", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (!res.ok) throw new Error("Failed to save");

      const result = await res.json();

      const mapped: TaskTemplate = {
        id: result.id,
        leadType: result.lead_type,
        roleType: result.role_type,
        name: result.name,
        order: result.order_index,
        deadlineRule: result.deadline_rule,
        isApsTask: result.is_aps_task,
      };

      if (form.id) {
        setTasks((prev) => prev.map((t) => (t.id === mapped.id ? mapped : t)));
      } else {
        setTasks((prev) => [...prev, mapped]);
      }

      setIsModalOpen(false);
      resetForm();
    } catch {
      alert("Error saving task template.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClasses =
    "w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm font-medium text-slate-800 outline-none focus:border-brand-primary focus:ring-2 focus:ring-brand-primary/10 transition-all bg-white placeholder:text-slate-300";

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {fetchError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
          <span className="font-black">DB Fetch Error:</span> {fetchError}
        </div>
      )}

      {/* Header Section */}
      <div className="flex justify-between items-start">
        <div className="flex items-start gap-4">
          <div className="bg-brand-primary/10 p-2.5 rounded-lg">
            <ClipboardList className="text-brand-primary" size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
              Task Templates
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Manage granular checklist items, deadline logic, and document
              requirements.
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
            <Search
              className="absolute left-3 top-3 text-slate-400"
              size={20}
            />
          </div>
          <button
            onClick={() => {
              resetForm();
              setIsModalOpen(true);
            }}
            className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={20} />
            New Task
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
                </div>
              </th>
              <th className="px-6 py-5">Role Type</th>
              <th className="px-6 py-5">Name</th>
              <th className="px-6 py-5">
                <div className="flex items-center gap-2">
                  <span>Order</span>
                  <ArrowUpDown size={12} className="text-slate-300" />
                </div>
              </th>
              <th className="px-6 py-5">Deadline Rule</th>
              <th className="px-6 py-5 text-center">APS Task</th>
              <th className="px-6 py-5 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filteredTasks.map((task) => (
              <tr
                key={task.id}
                className="hover:bg-slate-50/50 transition-colors"
              >
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
                  {task.deadlineRule || "—"}
                </td>
                <td className="px-6 py-5 text-center">
                  <div className="flex justify-center">
                    {task.isApsTask ? (
                      <div className="text-green-500 bg-green-50 p-1 rounded-full">
                        <CheckCircle2 size={20} />
                      </div>
                    ) : (
                      <div className="text-slate-300 bg-slate-50 p-1 rounded-full">
                        <XCircle size={20} />
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-6 py-5">
                  <div className="flex justify-center items-center gap-3">
                    <button
                      onClick={() => handleEdit(task)}
                      className="text-brand-primary hover:text-brand-primaryHover transition-colors"
                    >
                      <Edit size={18} />
                    </button>
                    <button
                      onClick={() => handleDelete(task.id)}
                      className="text-red-400 hover:text-red-600 transition-colors"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {filteredTasks.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-12 text-center text-slate-400 italic"
                >
                  No task templates found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 animate-in fade-in duration-200">
          <div
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            onClick={() => {
              setIsModalOpen(false);
              resetForm();
            }}
          />
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg relative z-10 overflow-hidden animate-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="p-8 border-b border-slate-100 flex justify-between items-start">
              <div>
                <h3 className="text-2xl font-black text-slate-900 leading-none">
                  {form.id ? "Edit Task Template" : "New Task Template"}
                </h3>
                <p className="text-slate-500 font-medium mt-2">
                  {form.id
                    ? "Update the task template details."
                    : "Create a new task template for a lead type."}
                </p>
              </div>
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  resetForm();
                }}
                className="text-slate-300 hover:text-slate-600 transition-colors mt-1"
              >
                <X size={24} />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleSubmit} className="p-8 space-y-5">
              {/* Lead Type */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Lead Type <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  className={inputClasses}
                  value={form.leadType}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, leadType: e.target.value }))
                  }
                >
                  {LEAD_TYPES.map((lt) => (
                    <option key={lt} value={lt}>
                      {lt}
                    </option>
                  ))}
                </select>
              </div>

              {/* Role Type */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Role Type <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Client, Agent, Lawyer"
                  className={inputClasses}
                  value={form.roleType}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, roleType: e.target.value }))
                  }
                />
              </div>

              {/* Name */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Task Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Upload Signed APS"
                  className={inputClasses}
                  value={form.name}
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, name: e.target.value }))
                  }
                />
              </div>

              {/* Order */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Order Index <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  required
                  min={1}
                  className={inputClasses}
                  value={form.order}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      order: parseInt(e.target.value) || 1,
                    }))
                  }
                />
              </div>

              {/* Deadline Rule */}
              <div className="space-y-2">
                <label className="block text-[11px] font-black text-slate-500 uppercase tracking-widest">
                  Deadline Rule{" "}
                  <span className="text-slate-300 font-medium normal-case">
                    (optional)
                  </span>
                </label>
                <input
                  type="text"
                  placeholder="e.g. 3 days before closing"
                  className={inputClasses}
                  value={form.deadlineRule}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      deadlineRule: e.target.value,
                    }))
                  }
                />
              </div>

              {/* Is APS Task Toggle */}
              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-100">
                <div>
                  <p className="text-sm font-bold text-slate-800">
                    Upload APS Task
                  </p>
                  <p className="text-xs text-slate-500 font-medium">
                    Mark if this task requires uploading an APS document.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      isApsTask: !prev.isApsTask,
                    }))
                  }
                  className={`relative w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none ${form.isApsTask ? "bg-brand-primary" : "bg-slate-300"}`}
                >
                  <span
                    className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${form.isApsTask ? "translate-x-6" : "translate-x-0"}`}
                  />
                </button>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    resetForm();
                  }}
                  className="px-6 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-bold text-sm hover:bg-slate-50 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-8 py-2.5 bg-brand-primary text-white rounded-xl font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmitting
                    ? "Saving..."
                    : form.id
                      ? "Update Task"
                      : "Create Task"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskTemplates;
