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
  is_default: boolean;
}

const LEAD_TYPES = ["Purchase", "Sale", "Refinance"];

const DEADLINE_RULES = [
  "N business days after task creation",
  "N days before lead closing date",
  "N days before lead requisition date",
];

const emptyForm = {
  id: "",
  leadType: "Purchase",
  roleType: "Client",
  name: "",
  order: 1,
  deadlineRule: DEADLINE_RULES[0],
  isApsTask: false,
  is_default: false,
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
            is_default: t.is_default ?? false,
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
      deadlineRule: task.deadlineRule || DEADLINE_RULES[0],
      isApsTask: task.isApsTask,
      is_default: task.is_default,
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
        is_default: result.is_default ?? false,
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">
                {form.id ? "Edit Task Template" : "New Task Template"}
              </h3>
              <button
                onClick={() => {
                  setIsModalOpen(false);
                  resetForm();
                }}
                className="text-slate-400 hover:text-slate-600"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="px-4 sm:px-6 py-4 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Task Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Upload Signed APS"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Lead Type *</label>
                  <select
                    required
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                    value={form.leadType}
                    onChange={(e) => setForm((prev) => ({ ...prev, leadType: e.target.value }))}
                  >
                    {LEAD_TYPES.map((lt) => (
                      <option key={lt} value={lt}>{lt}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Role Type *</label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Client, Agent, Lawyer"
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                    value={form.roleType}
                    onChange={(e) => setForm((prev) => ({ ...prev, roleType: e.target.value }))}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Order *</label>
                  <input
                    type="number"
                    required
                    min={1}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                    value={form.order}
                    onChange={(e) => setForm((prev) => ({ ...prev, order: parseInt(e.target.value) || 1 }))}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Deadline Rule</label>
                  <select
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:border-brand-primary"
                    value={form.deadlineRule}
                    onChange={(e) => setForm((prev) => ({ ...prev, deadlineRule: e.target.value }))}
                  >
                    {DEADLINE_RULES.map((rule) => (
                      <option key={rule} value={rule}>{rule}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.isApsTask}
                      onChange={() => setForm((prev) => ({ ...prev, isApsTask: !prev.isApsTask }))}
                      className="rounded border-slate-300"
                    />
                    APS Task
                  </label>
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.is_default}
                      onChange={() => setForm((prev) => ({ ...prev, is_default: !prev.is_default }))}
                      className="rounded border-slate-300"
                    />
                    Default
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    resetForm();
                  }}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center gap-2 bg-brand-primary text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-primary/90 transition-colors disabled:opacity-50"
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
