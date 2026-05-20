"use client";

import React, { useEffect, useState } from "react";
import { X, Plus, Trash2, Loader2, ExternalLink } from "lucide-react";
import Link from "next/link";

type DealRow = {
  id: string;
  file_number?: string | null;
  file_name?: string | null;
  type?: string | null;
  status?: string | null;
  lawyer_name?: string | null;
  clerk_name?: string | null;
  property_address?: string | null;
  closing_date?: string | null;
  opening_date?: string | null;
  requisition_date?: string | null;
  price?: number | null;
  outstanding_undertakings?: number | null;
  outstanding_requisitions?: number | null;
};

type TaskRow = {
  id: string;
  title: string;
  status?: string | null;
  due_date?: string | null;
  milestone_id?: string | null;
  is_shared?: boolean | null;
  task_template_id?: string | null;
  assignee?: string | null;
  completed?: boolean | null;
};

type MilestoneRow = {
  id: string;
  title: string;
  status?: string | null;
  milestone_date?: string | null;
  stage_template_id?: string | null;
};

type Toast = { message: string; type: "success" | "error" } | null;

interface EditDealModalProps {
  dealId: string;
  onClose: () => void;
  onSaved?: () => void;
}

const TYPE_OPTIONS = ["Purchase", "Sale", "Refinance", "Purchase & Sale"];
const STATUS_OPTIONS = ["Active", "Pending", "Closed", "Cancelled", "Urgent"];
const TASK_STATUS_OPTIONS = ["Pending", "In Progress", "Completed"];

// Native <input type="date"> in Chrome allows the user to type a 6-digit
// year. Restrict to a sane real-world window matching the rest of the app
// (DealList filters use the same range).
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2100-12-31";

// Reject anything outside the supported range so a stray 6-digit year never
// makes it to the database. Empty strings are valid (clears the field).
function isValidDateInput(value: string | null | undefined): boolean {
  if (!value) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return value >= DATE_MIN && value <= DATE_MAX;
}

// Convert API date (which may be "YYYY-MM-DD" or full timestamp) into the
// "YYYY-MM-DD" format a native date input expects.
function toDateInputValue(value?: string | null): string {
  if (!value) return "";
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return match ? match[1] : "";
}

const EditDealModal: React.FC<EditDealModalProps> = ({ dealId, onClose, onSaved }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<"details" | "tasks" | "milestones">(
    "details",
  );
  const [toast, setToast] = useState<Toast>(null);
  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 2500);
  };

  // Snapshot of editable deal fields (controlled inputs)
  const [form, setForm] = useState<DealRow>({ id: dealId });
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);

  // Initial load: deal, tasks, milestones in parallel
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const [dealRes, tasksRes, milestonesRes] = await Promise.all([
          fetch(`/api/admin/deals/${dealId}`),
          fetch(`/api/admin/tasks?deal_id=${dealId}`),
          fetch(`/api/admin/milestones?deal_id=${dealId}`),
        ]);
        const deal = await dealRes.json();
        const t = await tasksRes.json();
        const m = await milestonesRes.json();
        if (cancelled) return;
        if (deal && !deal.error) {
          setForm({
            id: deal.id,
            file_number: deal.file_number ?? "",
            file_name: deal.file_name ?? "",
            type: deal.type ?? "",
            status: deal.status ?? "Active",
            lawyer_name: deal.lawyer_name ?? "",
            clerk_name: deal.clerk_name ?? "",
            property_address: deal.property_address ?? "",
            closing_date: toDateInputValue(deal.closing_date),
            opening_date: toDateInputValue(deal.opening_date),
            requisition_date: toDateInputValue(deal.requisition_date),
            price: deal.price ?? 0,
            outstanding_undertakings: deal.outstanding_undertakings ?? 0,
            outstanding_requisitions: deal.outstanding_requisitions ?? 0,
          });
        }
        if (Array.isArray(t)) setTasks(t);
        if (Array.isArray(m)) setMilestones(m);
      } catch (err) {
        console.error("[EditDealModal] load failed", err);
        showToast("Failed to load deal", "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [dealId]);

  const updateField = <K extends keyof DealRow>(key: K, value: DealRow[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSaveDetails = async () => {
    for (const [label, value] of [
      ["Closing date", form.closing_date],
      ["Opening date", form.opening_date],
      ["Requisition date", form.requisition_date],
    ] as const) {
      if (!isValidDateInput(value)) {
        showToast(`${label} must be between 1900 and 2100`, "error");
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        file_number: form.file_number ?? "",
        file_name: form.file_name ?? "",
        type: form.type ?? "",
        status: form.status ?? "Active",
        lawyer_name: form.lawyer_name ?? "",
        clerk_name: form.clerk_name ?? "",
        property_address: form.property_address ?? "",
        closing_date: form.closing_date ?? "",
        opening_date: form.opening_date ?? "",
        requisition_date: form.requisition_date ?? "",
        price: Number(form.price) || 0,
        outstanding_undertakings: Number(form.outstanding_undertakings) || 0,
        outstanding_requisitions: Number(form.outstanding_requisitions) || 0,
      };
      const res = await fetch(`/api/admin/deals/${dealId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "Save failed");
      }
      showToast("Deal updated");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Save failed", "error");
    } finally {
      setSaving(false);
    }
  };

  // --- Task handlers --------------------------------------------------------

  const handleTaskFieldChange = (
    id: string,
    field: "title" | "status" | "due_date",
    value: string,
  ) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, [field]: value } : t)),
    );
  };

  const handleTaskSave = async (task: TaskRow) => {
    if (!isValidDateInput(task.due_date)) {
      showToast("Task due date must be between 1900 and 2100", "error");
      return;
    }
    try {
      const body: Record<string, any> = {
        id: task.id,
        status: task.status,
        due_date: task.due_date || null,
      };
      if (task.status === "Completed") {
        body.completed = true;
        body.completed_at = new Date().toISOString();
      } else {
        body.completed = false;
        body.completed_at = null;
      }
      const res = await fetch("/api/admin/tasks", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      showToast("Task saved");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to save task", "error");
    }
  };

  const handleTaskDelete = async (id: string) => {
    if (!confirm("Delete this task?")) return;
    try {
      const res = await fetch(`/api/admin/tasks?id=${id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      setTasks((prev) => prev.filter((t) => t.id !== id));
      showToast("Task deleted");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to delete", "error");
    }
  };

  // Empty-row template for the inline add UI
  const blankTask: { title: string; status: string; due_date: string; milestone_id: string } = {
    title: "",
    status: "Pending",
    due_date: "",
    milestone_id: "",
  };
  const [newTask, setNewTask] = useState(blankTask);

  const handleTaskAdd = async () => {
    if (!newTask.title.trim()) {
      showToast("Title is required", "error");
      return;
    }
    if (!isValidDateInput(newTask.due_date)) {
      showToast("Task due date must be between 1900 and 2100", "error");
      return;
    }
    try {
      const payload: Record<string, any> = {
        deal_id: dealId,
        title: newTask.title.trim(),
        status: newTask.status,
        due_date: newTask.due_date || null,
        milestone_id: newTask.milestone_id || null,
      };
      const res = await fetch("/api/admin/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      setTasks((prev) => [...prev, data.data as TaskRow]);
      setNewTask(blankTask);
      showToast("Task added");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to add task", "error");
    }
  };

  // --- Milestone handlers ---------------------------------------------------

  const handleMilestoneFieldChange = (
    id: string,
    field: "title" | "status" | "milestone_date",
    value: string,
  ) => {
    setMilestones((prev) =>
      prev.map((m) => (m.id === id ? { ...m, [field]: value } : m)),
    );
  };

  const handleMilestoneSave = async (m: MilestoneRow) => {
    if (!isValidDateInput(m.milestone_date)) {
      showToast("Stage date must be between 1900 and 2100", "error");
      return;
    }
    try {
      const body: Record<string, any> = {
        id: m.id,
        title: m.title,
        status: m.status,
        milestone_date: m.milestone_date || null,
      };
      if (m.status === "Completed") {
        body.completed_at = new Date().toISOString();
      } else {
        body.completed_at = null;
        body.email_sent = false;
      }
      const res = await fetch("/api/admin/milestones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      showToast("Stage saved");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to save stage", "error");
    }
  };

  const handleMilestoneDelete = async (id: string) => {
    if (!confirm("Delete this stage?")) return;
    try {
      const res = await fetch(`/api/admin/milestones?id=${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      setMilestones((prev) => prev.filter((m) => m.id !== id));
      showToast("Stage deleted");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to delete", "error");
    }
  };

  const blankMilestone = { title: "", status: "Pending", milestone_date: "" };
  const [newMilestone, setNewMilestone] = useState(blankMilestone);

  const handleMilestoneAdd = async () => {
    if (!newMilestone.title.trim()) {
      showToast("Title is required", "error");
      return;
    }
    if (!isValidDateInput(newMilestone.milestone_date)) {
      showToast("Stage date must be between 1900 and 2100", "error");
      return;
    }
    try {
      const payload = {
        deal_id: dealId,
        title: newMilestone.title.trim(),
        status: newMilestone.status,
        milestone_date: newMilestone.milestone_date || null,
      };
      const res = await fetch("/api/admin/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Failed");
      setMilestones((prev) => [...prev, data.data as MilestoneRow]);
      setNewMilestone(blankMilestone);
      showToast("Stage added");
      onSaved?.();
    } catch (err: any) {
      showToast(err?.message ?? "Failed to add stage", "error");
    }
  };

  // ---------------------------------------------------------------- render --

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-900">Edit deal</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {form.file_number ? `File ${form.file_number}` : "Loading…"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="border-b border-slate-200 px-6">
          <div className="flex gap-6 text-sm font-semibold">
            {(
              [
                ["details", "Details"],
                ["tasks", `Tasks (${tasks.length})`],
                ["milestones", `Stages (${milestones.length})`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`py-3 border-b-2 transition-colors ${
                  activeTab === key
                    ? "border-brand-primary text-brand-primary"
                    : "border-transparent text-slate-500 hover:text-slate-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-slate-500 gap-2">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : activeTab === "details" ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="File number" required>
                <input
                  type="text"
                  value={form.file_number ?? ""}
                  onChange={(e) => updateField("file_number", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="File name">
                <input
                  type="text"
                  value={form.file_name ?? ""}
                  onChange={(e) => updateField("file_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Type">
                <select
                  value={form.type ?? ""}
                  onChange={(e) => updateField("type", e.target.value)}
                  className={inputClass}
                >
                  <option value="">—</option>
                  {TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Status">
                <select
                  value={form.status ?? "Active"}
                  onChange={(e) => updateField("status", e.target.value)}
                  className={inputClass}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Lawyer">
                <input
                  type="text"
                  value={form.lawyer_name ?? ""}
                  onChange={(e) => updateField("lawyer_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Clerk">
                <input
                  type="text"
                  value={form.clerk_name ?? ""}
                  onChange={(e) => updateField("clerk_name", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Property address" className="md:col-span-2">
                <input
                  type="text"
                  value={form.property_address ?? ""}
                  onChange={(e) =>
                    updateField("property_address", e.target.value)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Closing date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.closing_date ?? ""}
                  onChange={(e) => updateField("closing_date", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Opening date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.opening_date ?? ""}
                  onChange={(e) => updateField("opening_date", e.target.value)}
                  className={inputClass}
                />
              </Field>
              <Field label="Requisition date">
                <input
                  type="date"
                  min={DATE_MIN}
                  max={DATE_MAX}
                  value={form.requisition_date ?? ""}
                  onChange={(e) =>
                    updateField("requisition_date", e.target.value)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Price">
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.price ?? 0}
                  onChange={(e) =>
                    updateField("price", Number(e.target.value) as any)
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Outstanding undertakings">
                <input
                  type="number"
                  min={0}
                  value={form.outstanding_undertakings ?? 0}
                  onChange={(e) =>
                    updateField(
                      "outstanding_undertakings",
                      Number(e.target.value) as any,
                    )
                  }
                  className={inputClass}
                />
              </Field>
              <Field label="Outstanding requisitions">
                <input
                  type="number"
                  min={0}
                  value={form.outstanding_requisitions ?? 0}
                  onChange={(e) =>
                    updateField(
                      "outstanding_requisitions",
                      Number(e.target.value) as any,
                    )
                  }
                  className={inputClass}
                />
              </Field>
            </div>
          ) : activeTab === "tasks" ? (
            <div className="space-y-2">
              {tasks.length === 0 && (
                <p className="text-xs text-slate-500 italic">
                  No tasks for this deal yet.
                </p>
              )}
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="grid grid-cols-12 gap-2 items-center bg-slate-50 border border-slate-200 rounded px-2 py-2"
                >
                  <input
                    type="text"
                    value={task.title}
                    onChange={(e) =>
                      handleTaskFieldChange(task.id, "title", e.target.value)
                    }
                    disabled
                    title="Task title cannot be renamed here — manage in deal detail view"
                    className="col-span-5 h-8 text-xs px-2 border border-slate-200 rounded bg-white text-slate-700 disabled:bg-slate-100 disabled:text-slate-500"
                  />
                  <select
                    value={task.status ?? "Pending"}
                    onChange={(e) =>
                      handleTaskFieldChange(task.id, "status", e.target.value)
                    }
                    className="col-span-3 h-8 text-xs px-2 border border-slate-200 rounded bg-white"
                  >
                    {TASK_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    min={DATE_MIN}
                    max={DATE_MAX}
                    value={toDateInputValue(task.due_date)}
                    onChange={(e) =>
                      handleTaskFieldChange(task.id, "due_date", e.target.value)
                    }
                    className="col-span-2 h-8 text-xs px-2 border border-slate-200 rounded bg-white"
                  />
                  <button
                    onClick={() => handleTaskSave(task)}
                    className="col-span-1 h-8 text-[11px] font-bold uppercase tracking-wide bg-brand-primary text-white rounded hover:bg-brand-primaryHover"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => handleTaskDelete(task.id)}
                    className="col-span-1 h-8 flex items-center justify-center text-slate-400 hover:text-red-500"
                    title="Delete task"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <div className="border-t border-slate-200 pt-3 mt-3">
                <p className="text-xs font-bold uppercase text-slate-500 mb-2">
                  Add task
                </p>
                <div className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    placeholder="Title"
                    value={newTask.title}
                    onChange={(e) =>
                      setNewTask((p) => ({ ...p, title: e.target.value }))
                    }
                    className="col-span-5 h-8 text-xs px-2 border border-slate-300 rounded"
                  />
                  <select
                    value={newTask.status}
                    onChange={(e) =>
                      setNewTask((p) => ({ ...p, status: e.target.value }))
                    }
                    className="col-span-3 h-8 text-xs px-2 border border-slate-300 rounded bg-white"
                  >
                    {TASK_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    min={DATE_MIN}
                    max={DATE_MAX}
                    value={newTask.due_date}
                    onChange={(e) =>
                      setNewTask((p) => ({ ...p, due_date: e.target.value }))
                    }
                    className="col-span-2 h-8 text-xs px-2 border border-slate-300 rounded"
                  />
                  <button
                    onClick={handleTaskAdd}
                    className="col-span-2 h-8 text-[11px] font-bold uppercase tracking-wide bg-brand-primary text-white rounded hover:bg-brand-primaryHover inline-flex items-center justify-center gap-1"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {milestones.length === 0 && (
                <p className="text-xs text-slate-500 italic">
                  No stages for this deal yet.
                </p>
              )}
              {milestones.map((m) => (
                <div
                  key={m.id}
                  className="grid grid-cols-12 gap-2 items-center bg-slate-50 border border-slate-200 rounded px-2 py-2"
                >
                  <input
                    type="text"
                    value={m.title}
                    onChange={(e) =>
                      handleMilestoneFieldChange(m.id, "title", e.target.value)
                    }
                    className="col-span-5 h-8 text-xs px-2 border border-slate-200 rounded bg-white"
                  />
                  <select
                    value={m.status ?? "Pending"}
                    onChange={(e) =>
                      handleMilestoneFieldChange(m.id, "status", e.target.value)
                    }
                    className="col-span-3 h-8 text-xs px-2 border border-slate-200 rounded bg-white"
                  >
                    {TASK_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    min={DATE_MIN}
                    max={DATE_MAX}
                    value={toDateInputValue(m.milestone_date)}
                    onChange={(e) =>
                      handleMilestoneFieldChange(
                        m.id,
                        "milestone_date",
                        e.target.value,
                      )
                    }
                    className="col-span-2 h-8 text-xs px-2 border border-slate-200 rounded bg-white"
                  />
                  <button
                    onClick={() => handleMilestoneSave(m)}
                    className="col-span-1 h-8 text-[11px] font-bold uppercase tracking-wide bg-brand-primary text-white rounded hover:bg-brand-primaryHover"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => handleMilestoneDelete(m.id)}
                    className="col-span-1 h-8 flex items-center justify-center text-slate-400 hover:text-red-500"
                    title="Delete stage"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}

              <div className="border-t border-slate-200 pt-3 mt-3">
                <p className="text-xs font-bold uppercase text-slate-500 mb-2">
                  Add stage
                </p>
                <div className="grid grid-cols-12 gap-2 items-center">
                  <input
                    type="text"
                    placeholder="Title"
                    value={newMilestone.title}
                    onChange={(e) =>
                      setNewMilestone((p) => ({ ...p, title: e.target.value }))
                    }
                    className="col-span-5 h-8 text-xs px-2 border border-slate-300 rounded"
                  />
                  <select
                    value={newMilestone.status}
                    onChange={(e) =>
                      setNewMilestone((p) => ({ ...p, status: e.target.value }))
                    }
                    className="col-span-3 h-8 text-xs px-2 border border-slate-300 rounded bg-white"
                  >
                    {TASK_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    min={DATE_MIN}
                    max={DATE_MAX}
                    value={newMilestone.milestone_date}
                    onChange={(e) =>
                      setNewMilestone((p) => ({
                        ...p,
                        milestone_date: e.target.value,
                      }))
                    }
                    className="col-span-2 h-8 text-xs px-2 border border-slate-300 rounded"
                  />
                  <button
                    onClick={handleMilestoneAdd}
                    className="col-span-2 h-8 text-[11px] font-bold uppercase tracking-wide bg-brand-primary text-white rounded hover:bg-brand-primaryHover inline-flex items-center justify-center gap-1"
                  >
                    <Plus size={12} /> Add
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50">
          <Link
            href={`/admin/deals/${dealId}`}
            className="text-xs text-brand-primary hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink size={12} />
            Open full deal view
          </Link>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-9 px-4 rounded text-xs font-bold uppercase tracking-wide border border-slate-300 text-slate-700 hover:bg-slate-100"
            >
              Close
            </button>
            {activeTab === "details" && (
              <button
                onClick={handleSaveDetails}
                disabled={saving || loading}
                className="h-9 px-4 rounded text-xs font-bold uppercase tracking-wide bg-brand-primary text-white hover:bg-brand-primaryHover disabled:opacity-60 inline-flex items-center gap-2"
              >
                {saving && <Loader2 size={12} className="animate-spin" />}
                Save changes
              </button>
            )}
          </div>
        </div>

        {toast && (
          <div
            className={`absolute bottom-20 right-6 px-3 py-2 rounded shadow-md text-xs font-medium ${
              toast.type === "success"
                ? "bg-green-600 text-white"
                : "bg-red-600 text-white"
            }`}
          >
            {toast.message}
          </div>
        )}
      </div>
    </div>
  );
};

const inputClass =
  "w-full h-9 border border-slate-300 rounded px-2 text-xs text-slate-700 focus:border-brand-primary outline-none bg-white";

const Field: React.FC<{
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ label, required, className, children }) => (
  <div className={className}>
    <label className="block text-xs font-medium text-slate-600 mb-1">
      {label}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
    {children}
  </div>
);

export default EditDealModal;
