"use client";

import React, { useState, useEffect } from "react";
import {
  ChevronDown,
  ChevronRight,
  Search,
  Plus,
  X,
  Trash2,
  GripVertical,
  Workflow,
  Layers,
  ClipboardList,
  Pencil,
} from "lucide-react";
import StageTemplateFormModal from "@/components/shared/StageTemplateFormModal";
import TaskTemplateFormModal from "@/components/shared/TaskTemplateFormModal";

interface StageTemplate {
  id: string;
  name: string;
  lead_type: string;
  order_index: number;
  role: string;
  email_template_id: string | null;
  email_templates: { id: string; name: string } | null;
  description: { short?: string; modal?: string; task?: string } | null;
}

interface TaskTemplate {
  id: string;
  lead_type: string;
  role_type: string;
  name: string;
  order_index: number;
  deadline_rule: string | null;
  is_aps_task: boolean;
  is_default: boolean;
  stage_template_id: string | null;
  stage_templates: { id: string; name: string } | null;
}

type LeadType = "Purchase" | "Sale" | "Refinance";

const LEAD_TYPES: LeadType[] = ["Purchase", "Sale", "Refinance"];


const DefaultTasks: React.FC = () => {
  const [stages, setStages] = useState<StageTemplate[]>([]);
  const [tasks, setTasks] = useState<TaskTemplate[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeLeadType, setActiveLeadType] = useState<LeadType>("Purchase");
  const [expandedStages, setExpandedStages] = useState<Set<string>>(new Set());

  // Assign modal
  const [assignModal, setAssignModal] = useState<{ taskId: string; currentStageId: string | null } | null>(null);

  // Shared form modals
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskFormStageId, setTaskFormStageId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<TaskTemplate | null>(null);
  const [showStageForm, setShowStageForm] = useState(false);
  const [editingStage, setEditingStage] = useState<StageTemplate | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [stagesRes, tasksRes, emailRes] = await Promise.all([
          fetch("/api/admin/milestone-templates"),
          fetch("/api/admin/task-templates"),
          fetch("/api/admin/email-templates"),
        ]);
        const stagesData = await stagesRes.json();
        const tasksData = await tasksRes.json();
        const emailData = await emailRes.json();
        if (Array.isArray(stagesData)) setStages(stagesData);
        if (Array.isArray(tasksData)) setTasks(tasksData);
        if (Array.isArray(emailData)) setEmailTemplates(emailData);

        // Expand all stages + unassigned by default
        if (Array.isArray(stagesData)) {
          setExpandedStages(new Set([...stagesData.map((s: StageTemplate) => s.id), "__unassigned__"]));
        }
      } catch (err) {
        console.error("Failed to fetch workflow data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  // Filter by active lead type
  const filteredStages = stages
    .filter((s) => s.lead_type === activeLeadType)
    .sort((a, b) => a.order_index - b.order_index);

  const filteredTasks = tasks.filter((t) => t.lead_type === activeLeadType);

  const search = searchTerm.toLowerCase();
  const taskMatchesSearch = (t: TaskTemplate) =>
    !search ||
    t.name.toLowerCase().includes(search) ||
    t.role_type.toLowerCase().includes(search) ||
    (t.deadline_rule && t.deadline_rule.toLowerCase().includes(search));

  const stageMatchesSearch = (s: StageTemplate) =>
    !search ||
    s.name.toLowerCase().includes(search) ||
    s.role.toLowerCase().includes(search);

  const getTasksForStage = (stageId: string) =>
    filteredTasks
      .filter((t) => t.stage_template_id === stageId && taskMatchesSearch(t))
      .sort((a, b) => a.order_index - b.order_index);

  const getAllTasksForStage = (stageId: string) =>
    filteredTasks
      .filter((t) => t.stage_template_id === stageId)
      .sort((a, b) => a.order_index - b.order_index);

  const unassignedTasks = filteredTasks
    .filter((t) => !t.stage_template_id && taskMatchesSearch(t))
    .sort((a, b) => a.order_index - b.order_index);

  // When searching, only show stages that match or have matching tasks
  const visibleStages = search
    ? filteredStages.filter(
        (stage) =>
          stageMatchesSearch(stage) ||
          getTasksForStage(stage.id).length > 0
      )
    : filteredStages;

  const toggleStage = (stageId: string) => {
    setExpandedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stageId)) next.delete(stageId);
      else next.add(stageId);
      return next;
    });
  };

  // Assign task to stage
  const handleAssignTask = async (taskId: string, stageTemplateId: string | null) => {
    try {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      await fetch("/api/admin/task-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: task.id,
          leadType: task.lead_type,
          roleType: task.role_type,
          name: task.name,
          order: task.order_index,
          deadlineRule: task.deadline_rule,
          isApsTask: task.is_aps_task,
          is_default: task.is_default,
          stageTemplateId: stageTemplateId,
        }),
      });

      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? {
                ...t,
                stage_template_id: stageTemplateId,
                stage_templates: stageTemplateId
                  ? { id: stageTemplateId, name: stages.find((s) => s.id === stageTemplateId)?.name || "" }
                  : null,
              }
            : t
        )
      );
      setAssignModal(null);
    } catch {
      alert("Failed to update task assignment.");
    }
  };

  // Callback when shared stage form creates or updates a stage
  const handleStageSaved = (result: any) => {
    if (editingStage) {
      // Update existing stage in state
      setStages((prev) => prev.map((s) => (s.id === result.id ? result : s)));
      setEditingStage(null);
    } else {
      // New stage
      setStages((prev) => [...prev, result]);
      setExpandedStages((prev) => new Set([...prev, result.id]));
    }
  };

  // Callback when shared task form creates or updates a task
  const handleTaskSaved = (result: any, isEdit: boolean) => {
    const mapped: TaskTemplate = {
      id: result.id,
      lead_type: result.lead_type,
      role_type: result.role_type,
      name: result.name,
      order_index: result.order_index,
      deadline_rule: result.deadline_rule,
      is_aps_task: result.is_aps_task,
      is_default: result.is_default ?? false,
      stage_template_id: result.stage_template_id ?? null,
      stage_templates: result.stage_template_id
        ? { id: result.stage_template_id, name: stages.find((s) => s.id === result.stage_template_id)?.name || "" }
        : null,
    };
    if (isEdit) {
      setTasks((prev) => prev.map((t) => (t.id === mapped.id ? mapped : t)));
      setEditingTask(null);
    } else {
      setTasks((prev) => [...prev, mapped]);
    }
    setTaskFormStageId(null);
  };

  // Delete task
  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Delete this task template?")) return;
    try {
      const res = await fetch(`/api/admin/task-templates?id=${taskId}`, { method: "DELETE" });
      if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== taskId));
      else alert("Failed to delete.");
    } catch {
      alert("Error deleting task.");
    }
  };

  const TaskRow = ({ task, index }: { task: TaskTemplate; index: number }) => (
    <tr className="hover:bg-slate-50 transition-colors group">
      <td className="px-2 sm:px-3 py-3 text-slate-300 hidden sm:table-cell">
        <GripVertical size={14} />
      </td>
      <td className="px-2 sm:px-3 py-3 text-xs text-slate-500 font-medium text-center">{index + 1}</td>
      <td className="px-2 sm:px-3 py-3">
        <span className="text-xs sm:text-sm font-semibold text-slate-800">{task.name}</span>
      </td>
      <td className="px-2 sm:px-3 py-3 hidden md:table-cell">
        <span className="text-xs text-slate-500 font-medium">{task.role_type}</span>
      </td>
      <td className="px-2 sm:px-3 py-3 hidden lg:table-cell">
        <span className="text-xs text-slate-500">{task.deadline_rule || "—"}</span>
      </td>
      <td className="px-2 sm:px-3 py-3 text-center hidden sm:table-cell">
        {task.is_default ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold bg-green-50 text-green-700 border border-green-200">
            Default
          </span>
        ) : (
          <span className="text-slate-300 text-xs">—</span>
        )}
      </td>
      <td className="px-2 sm:px-3 py-3">
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => {
              setEditingTask(task);
              setShowTaskForm(true);
            }}
            className="text-slate-400 hover:text-brand-primary transition-colors p-1"
            title="Edit task"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => handleDeleteTask(task.id)}
            className="text-slate-300 hover:text-red-500 transition-colors p-1"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </td>
    </tr>
  );

  const TaskTableHeader = () => (
    <thead className="bg-slate-50/80 border-b border-slate-100">
      <tr>
        <th className="px-2 sm:px-3 py-2 w-8 hidden sm:table-cell"></th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-10 text-center">#</th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider">Task Name</th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-24 hidden md:table-cell">Role</th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-48 hidden lg:table-cell">Deadline Rule</th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-20 text-center hidden sm:table-cell">Default</th>
        <th className="px-2 sm:px-3 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-28 text-right">Actions</th>
      </tr>
    </thead>
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div className="flex items-start gap-4">
          <div className="bg-brand-primary/10 p-2.5 rounded-lg">
            <Workflow className="text-brand-primary" size={32} />
          </div>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">Default Tasks</h1>
            <p className="text-sm text-slate-500 mt-1">
              Map default task templates to stage milestones for each lead type.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowStageForm(true)}
            className="bg-brand-primary text-white px-4 py-2 rounded-xl flex items-center gap-2 font-bold text-sm shadow-lg shadow-brand-primary/20 hover:bg-brand-primaryHover transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">Add Stage Templates</span>
            <span className="sm:hidden">Stage</span>
          </button>
          <button
            onClick={() => {
              setTaskFormStageId(null);
              setShowTaskForm(true);
            }}
            className="bg-white border border-slate-300 text-slate-700 px-4 py-2 rounded-xl flex items-center gap-2 font-bold text-sm hover:bg-slate-50 transition-all active:scale-95 whitespace-nowrap"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">Add Task Templates</span>
            <span className="sm:hidden">Task</span>
          </button>
        </div>
      </div>

      {/* Lead Type Tabs + Search */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl w-full sm:w-auto">
          {LEAD_TYPES.map((lt) => (
            <button
              key={lt}
              onClick={() => setActiveLeadType(lt)}
              className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeLeadType === lt
                  ? "bg-white text-brand-primary shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              {lt}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <input
            type="text"
            placeholder="Search stages or tasks..."
            className="w-full pl-10 pr-9 py-2.5 bg-white border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/20 focus:border-brand-primary transition-all shadow-sm"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <Search className="absolute left-3 top-3 text-slate-400" size={20} />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm("")}
              className="absolute right-3 top-3 text-slate-400 hover:text-slate-600"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Workflow Sections */}
      <div className="space-y-4">
        {visibleStages.map((stage) => {
          // If stage name matches search, show all its tasks; otherwise only matching tasks
          const stageTasks =
            search && stageMatchesSearch(stage)
              ? getAllTasksForStage(stage.id)
              : getTasksForStage(stage.id);
          const isExpanded = expandedStages.has(stage.id) || !!search;

          return (
            <div
              key={stage.id}
              className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden"
            >
              {/* Stage Header */}
              <div className="px-3 sm:px-5 py-3 sm:py-4 hover:bg-slate-50 transition-colors">
                <div className="flex items-center justify-between">
                  <button
                    onClick={() => toggleStage(stage.id)}
                    className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0"
                  >
                    {isExpanded ? (
                      <ChevronDown size={18} className="text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight size={18} className="text-slate-400 shrink-0" />
                    )}
                    <div className="bg-brand-primary/10 p-1.5 rounded-md shrink-0">
                      <Layers size={16} className="text-brand-primary" />
                    </div>
                    <div className="text-left min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                        <h3 className="text-sm font-bold text-slate-800">{stage.name}</h3>
                        <div className="flex items-center gap-x-2">
                          <span className="text-[11px] text-slate-400 font-medium">{stage.role}</span>
                          <span className="text-slate-300 text-[10px]">&middot;</span>
                          <span className="text-[11px] text-slate-400">Order: {stage.order_index}</span>
                          {stage.email_templates && (
                            <>
                              <span className="text-slate-300 text-[10px]">&middot;</span>
                              <span className="text-[11px] text-brand-primary font-medium">
                                Email: {stage.email_templates.name}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {stage.description?.short && (
                        <p className="text-[11px] italic text-slate-400 mt-1 line-clamp-1">{stage.description.short}</p>
                      )}
                    </div>
                  </button>
                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full hidden sm:inline">
                      {stageTasks.length} task{stageTasks.length !== 1 ? "s" : ""}
                    </span>
                    <span className="text-xs font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded-full sm:hidden">
                      {stageTasks.length}
                    </span>
                    <button
                      onClick={() => {
                        setEditingStage(stage);
                        setShowStageForm(true);
                      }}
                      className="text-slate-400 hover:text-brand-primary hover:bg-brand-light p-1.5 rounded-md transition-colors"
                      title="Edit stage"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => {
                        setTaskFormStageId(stage.id);
                        setShowTaskForm(true);
                      }}
                      className="text-brand-primary hover:bg-brand-light p-1.5 rounded-md transition-colors"
                      title="Add task to this stage"
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              </div>

              {/* Tasks Table */}
              {isExpanded && (
                <div className="border-t border-slate-100">
                    {stageTasks.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left min-w-[400px]">
                          <TaskTableHeader />
                          <tbody className="divide-y divide-slate-50">
                            {stageTasks.map((task, i) => (
                              <TaskRow key={task.id} task={task} index={i} />
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="px-5 py-8 text-center text-sm text-slate-400 italic">
                        No tasks assigned to this stage.
                      </div>
                    )}
                  </div>
              )}
            </div>
          );
        })}

        {/* Unassigned Tasks Section */}
        {unassignedTasks.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-dashed border-slate-300 overflow-hidden">
            <button
              onClick={() => toggleStage("__unassigned__")}
              className="w-full flex items-center justify-between px-3 sm:px-5 py-3 sm:py-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                {expandedStages.has("__unassigned__") ? (
                  <ChevronDown size={18} className="text-slate-400 shrink-0" />
                ) : (
                  <ChevronRight size={18} className="text-slate-400 shrink-0" />
                )}
                <div className="bg-amber-50 p-1.5 rounded-md shrink-0">
                  <ClipboardList size={16} className="text-amber-600" />
                </div>
                <div className="text-left min-w-0">
                  <h3 className="text-sm font-bold text-slate-600">Unassigned Tasks</h3>
                  <p className="text-xs text-slate-400 mt-0.5 hidden sm:block">
                    Tasks not linked to any stage milestone
                  </p>
                </div>
              </div>
              <span className="text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full shrink-0">
                {unassignedTasks.length} task{unassignedTasks.length !== 1 ? "s" : ""}
              </span>
            </button>

            {expandedStages.has("__unassigned__") && (
              <div className="border-t border-slate-200">
                <div className="overflow-x-auto">
                  <table className="w-full text-left min-w-[400px]">
                    <TaskTableHeader />
                    <tbody className="divide-y divide-slate-50">
                      {unassignedTasks.map((task, i) => (
                        <TaskRow key={task.id} task={task} index={i} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {visibleStages.length === 0 && unassignedTasks.length === 0 && (
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 px-6 py-16 text-center">
            <p className="text-slate-400 text-sm">
              {search
                ? `No results found for "${searchTerm}".`
                : `No default tasks for ${activeLeadType} lead type.`}
            </p>
          </div>
        )}
      </div>

      {/* Assign Modal */}
      {assignModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Assign to Stage</h3>
              <button onClick={() => setAssignModal(null)} className="text-slate-400 hover:text-slate-600">
                <X size={20} />
              </button>
            </div>
            <div className="px-4 sm:px-6 py-4 space-y-3">
              <p className="text-sm text-slate-500 mb-4">
                Select which stage milestone this task belongs to:
              </p>

              <button
                onClick={() => handleAssignTask(assignModal.taskId, null)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors text-sm ${
                  !assignModal.currentStageId
                    ? "border-brand-primary bg-brand-light text-brand-primary font-semibold"
                    : "border-slate-200 hover:bg-slate-50 text-slate-600"
                }`}
              >
                No Stage (Unassigned)
              </button>

              {filteredStages.map((stage) => (
                <button
                  key={stage.id}
                  onClick={() => handleAssignTask(assignModal.taskId, stage.id)}
                  className={`w-full text-left px-4 py-3 rounded-lg border transition-colors text-sm ${
                    assignModal.currentStageId === stage.id
                      ? "border-brand-primary bg-brand-light text-brand-primary font-semibold"
                      : "border-slate-200 hover:bg-slate-50 text-slate-700"
                  }`}
                >
                  <span className="font-medium">{stage.name}</span>
                  <span className="text-xs text-slate-400 ml-2">({stage.role})</span>
                </button>
              ))}
            </div>
            <div className="px-4 sm:px-6 py-3 border-t border-slate-100 flex justify-end">
              <button
                onClick={() => setAssignModal(null)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Shared Task Template Form Modal */}
      <TaskTemplateFormModal
        open={showTaskForm}
        onClose={() => { setShowTaskForm(false); setTaskFormStageId(null); setEditingTask(null); }}
        onSaved={handleTaskSaved}
        stageTemplates={stages.map((s) => ({ id: s.id, name: s.name, lead_type: s.lead_type }))}
        defaultLeadType={activeLeadType}
        defaultStageTemplateId={taskFormStageId}
        hideLeadType
        editData={editingTask ? {
          id: editingTask.id,
          leadType: editingTask.lead_type,
          roleType: editingTask.role_type,
          name: editingTask.name,
          order: editingTask.order_index,
          deadlineRule: editingTask.deadline_rule,
          isApsTask: editingTask.is_aps_task,
          is_default: editingTask.is_default,
          stageTemplateId: editingTask.stage_template_id,
        } : null}
      />

      {/* Shared Stage Template Form Modal */}
      <StageTemplateFormModal
        open={showStageForm}
        onClose={() => { setShowStageForm(false); setEditingStage(null); }}
        onCreated={handleStageSaved}
        emailTemplates={emailTemplates}
        defaultLeadType={activeLeadType}
        defaultOrderIndex={filteredStages.length + 1}
        hideLeadType
        editData={editingStage}
      />
    </div>
  );
};

export default DefaultTasks;
