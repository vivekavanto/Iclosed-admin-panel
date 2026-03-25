"use client";

import React, { useState, useEffect } from "react";
import {
  Search,
  Plus,
  CheckCircle2,
  XCircle,
  ClipboardList,
  ArrowUpDown,
  Edit,
  Trash2,
} from "lucide-react";
import TaskTemplateFormModal from "@/components/shared/TaskTemplateFormModal";

interface TaskTemplate {
  id: string;
  leadType: string;
  roleType: string;
  name: string;
  order: number;
  deadlineRule: string | null;
  isApsTask: boolean;
  is_default: boolean;
  stageTemplateId: string | null;
  stageName: string | null;
}

const TaskTemplates: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const [tasks, setTasks] = useState<TaskTemplate[]>([]);
  const [stageTemplates, setStageTemplates] = useState<{ id: string; name: string; lead_type: string }[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<TaskTemplate | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

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
            stageTemplateId: t.stage_template_id ?? null,
            stageName: t.stage_templates?.name ?? null,
          })),
        );
      } catch (err: any) {
        setFetchError(err.message);
      }
    };

    fetchTasks();

    fetch("/api/admin/milestone-templates")
      .then((res) => res.json())
      .then((data) => { if (Array.isArray(data)) setStageTemplates(data); })
      .catch(() => {});
  }, []);

  const handleEdit = (task: TaskTemplate) => {
    setEditingTask(task);
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

  const handleTaskSaved = (result: any, isEdit: boolean) => {
    const mapped: TaskTemplate = {
      id: result.id,
      leadType: result.lead_type,
      roleType: result.role_type,
      name: result.name,
      order: result.order_index,
      deadlineRule: result.deadline_rule,
      isApsTask: result.is_aps_task,
      is_default: result.is_default ?? false,
      stageTemplateId: result.stage_template_id ?? null,
      stageName: result.stage_templates?.name ?? null,
    };

    if (isEdit) {
      setTasks((prev) => prev.map((t) => (t.id === mapped.id ? mapped : t)));
    } else {
      setTasks((prev) => [...prev, mapped]);
    }
    setEditingTask(null);
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {fetchError && (
        <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 font-medium">
          <span className="font-black">DB Fetch Error:</span> {fetchError}
        </div>
      )}

      {/* Header Section */}
      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-start">
        <div className="flex items-start gap-4">
          <div className="bg-brand-primary/10 p-2.5 rounded-lg shrink-0">
            <ClipboardList className="text-brand-primary" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
              Task Templates
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Manage granular checklist items, deadline logic, and document
              requirements.
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
          <div className="relative w-full sm:w-72">
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
              setEditingTask(null);
              setIsModalOpen(true);
            }}
            className="bg-brand-primary text-white px-5 py-2.5 rounded-xl flex items-center justify-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={20} />
            New Task
          </button>
        </div>
      </div>

      {/* Table Section – visible on lg and up */}
      <div className="hidden lg:block bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
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
                  </div>
                </th>
                <th className="px-6 py-5">Deadline Rule</th>
                <th className="px-6 py-5">Stage</th>
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
                  <td className="px-6 py-5">
                    {task.stageName ? (
                      <span className="inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-bold bg-brand-light text-brand-primary border border-brand-primary/20">
                        {task.stageName}
                      </span>
                    ) : (
                      <span className="text-slate-300 text-xs">—</span>
                    )}
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
                    colSpan={8}
                    className="px-6 py-12 text-center text-slate-400 italic"
                  >
                    No task templates found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Card Layout – visible below lg */}
      <div className="lg:hidden space-y-3">
        {filteredTasks.map((task) => (
          <div
            key={task.id}
            className="bg-white rounded-xl shadow-sm border border-slate-200 p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold text-slate-800 leading-tight">
                  {task.name}
                </p>
                <div className="flex flex-wrap items-center gap-2 mt-1.5">
                  <span className="text-xs font-bold text-brand-primary">
                    {task.leadType}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-xs text-slate-500 font-medium">
                    {task.roleType}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleEdit(task)}
                  className="text-brand-primary hover:text-brand-primaryHover transition-colors p-1"
                >
                  <Edit size={18} />
                </button>
                <button
                  onClick={() => handleDelete(task.id)}
                  className="text-red-400 hover:text-red-600 transition-colors p-1"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
              <span>
                <span className="font-semibold text-slate-600">Order:</span>{" "}
                {task.order}
              </span>
              <span>
                <span className="font-semibold text-slate-600">Deadline:</span>{" "}
                <span className="italic">{task.deadlineRule || "—"}</span>
              </span>
              {task.stageName && (
                <span className="inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-bold bg-brand-light text-brand-primary border border-brand-primary/20">
                  {task.stageName}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <span className="font-semibold text-slate-600">APS:</span>
                {task.isApsTask ? (
                  <CheckCircle2 size={14} className="text-green-500" />
                ) : (
                  <XCircle size={14} className="text-slate-300" />
                )}
              </span>
            </div>
          </div>
        ))}
        {filteredTasks.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 px-6 py-12 text-center text-slate-400 italic">
            No task templates found.
          </div>
        )}
      </div>

      {/* Shared Task Template Form Modal */}
      <TaskTemplateFormModal
        open={isModalOpen}
        onClose={() => { setIsModalOpen(false); setEditingTask(null); }}
        onSaved={handleTaskSaved}
        stageTemplates={stageTemplates}
        editData={editingTask ? {
          id: editingTask.id,
          leadType: editingTask.leadType,
          roleType: editingTask.roleType,
          name: editingTask.name,
          order: editingTask.order,
          deadlineRule: editingTask.deadlineRule,
          isApsTask: editingTask.isApsTask,
          is_default: editingTask.is_default,
          stageTemplateId: editingTask.stageTemplateId,
        } : null}
      />
    </div>
  );
};

export default TaskTemplates;
