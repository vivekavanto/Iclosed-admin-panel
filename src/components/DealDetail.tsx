"use client";

import React, { useState, useRef, useEffect } from "react";
import { Deal, Task, Milestone } from "../types";
import {
  ArrowLeft,
  Calendar,
  User,
  Building2,
  Trash2,
  Plus,
  Mail,
  CheckCircle,
  GripVertical,
  FileText,
  ChevronDown,
  Pencil,
  Eye,
  Download,
  Copy,
  ExternalLink,
} from "lucide-react";
import { useRouter } from "next/navigation";

interface DealDetailProps {
  deal: Deal;
  rawDeal?: Record<string, any> | null;
  onBack?: () => void;
}

const DealDetail: React.FC<DealDetailProps> = ({ deal, rawDeal, onBack }) => {
  const router = useRouter();
  const handleBack = onBack || (() => router.push("/deals"));

  const mapApiTask = (t: any): Task => ({
    id: t.id,
    title: t.title,
    completed: t.completed ?? false,
    status: t.status,
    dueDate: t.due_date ?? t.dueDate,
    assignee: t.assignee,
    completedAt: t.completed_at ?? t.completedAt,
    document: t.document_name ? { name: t.document_name, url: t.document_url ?? '#' } : undefined,
    milestoneId: t.milestone_id ?? undefined,
  });

  // Use state to allow modification simulation
  const [tasks, setTasks] = useState<Task[]>(deal.tasks || []);
  const [milestones, setMilestones] = useState<Milestone[]>(
    deal.milestones || [],
  );

  // Extended display types with template flag
  type DisplayTask = Task & { isTemplate?: boolean };
  type DisplayMilestone = Milestone & { isTemplate?: boolean };

  // View task detail modal
  const [viewingTask, setViewingTask] = useState<DisplayTask | null>(null);
  const [viewTaskResponses, setViewTaskResponses] = useState<any[]>([]);
  const [loadingTaskResponses, setLoadingTaskResponses] = useState(false);

  const openTaskView = async (task: DisplayTask) => {
    setViewingTask(task);
    setViewTaskResponses([]);
    if (task.isTemplate) return;
    setLoadingTaskResponses(true);
    try {
      const res = await fetch(`/api/admin/task-responses?task_id=${task.id}`);
      const data = await res.json();
      if (Array.isArray(data)) setViewTaskResponses(data);
    } catch { }
    setLoadingTaskResponses(false);
  };

  // Toast state
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);
  const showToast = (message: string, type: "success" | "error" = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Documents modal state
  const [showDocuments, setShowDocuments] = useState(false);
  const [dealDocuments, setDealDocuments] = useState<{ task_id: string; file_name: string; file_url: string; task_title: string }[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(false);

  // Drag and Drop State
  const dragTaskItem = useRef<number | null>(null);
  const dragTaskOverItem = useRef<number | null>(null);
  const dragMilestoneItem = useRef<number | null>(null);
  const dragMilestoneOverItem = useRef<number | null>(null);

  const refetchData = async () => {
    try {
      const [tasksRes, milestonesRes] = await Promise.all([
        fetch(`/api/admin/tasks?deal_id=${deal.id}`),
        fetch(`/api/admin/milestones?deal_id=${deal.id}`),
      ]);
      const tasksData = await tasksRes.json();
      const milestonesData = await milestonesRes.json();
      if (Array.isArray(tasksData)) setTasks(tasksData.map(mapApiTask));
      if (Array.isArray(milestonesData)) {
        setMilestones(milestonesData.map((m: any): Milestone => ({
          id: m.id,
          title: m.title,
          status: m.status ?? "",
          milestoneDate: m.milestone_date ?? undefined,
          completedAt: m.completed_at ?? undefined,
          emailSent: m.email_sent ?? false,
          emailTemplateId: m.email_template_id ?? null,
        })));
      }
    } catch { }
  };

  const fetchDealDocuments = async () => {
    setLoadingDocs(true);
    try {
      const res = await fetch(`/api/admin/task-responses?deal_id=${deal.id}`);
      const data = await res.json();
      if (Array.isArray(data)) setDealDocuments(data);
    } catch {
      setDealDocuments([]);
    } finally {
      setLoadingDocs(false);
    }
  };

  // --- Handlers ---

  // Milestones
  const handleMilestoneStatusChange = async (
    id: string,
    newStatus: Milestone["status"],
  ) => {

    // Optimistic UI update (already exists)
    setMilestones((prev) =>
      prev.map((m) => {
        if (m.id === id) {
          const updates: Partial<Milestone> = { status: newStatus };
          if (newStatus === "Completed" && !m.completedAt) {
            updates.completedAt = new Date().toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            });
          } else if (newStatus !== "Completed") {
            updates.completedAt = undefined;
          }
          return { ...m, ...updates };
        }
        return m;
      }),
    );

    if (newStatus === "Completed") {
      const milestone = milestones.find((m) => m.id === id);
      if (milestone?.emailTemplateId) {
        // Send email + update status (the email API handles completed_at)
        try {
          const res = await fetch("/api/admin/send-milestone-email", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ milestoneId: id, dealId: deal.id }),
          });
          const data = await res.json();
          if (data.success) {
            showToast(data.alreadySent ? "Email was already sent for this milestone." : "Milestone email sent successfully!");
          } else {
            showToast(data.error || "Failed to send milestone email", "error");
          }
        } catch {
          showToast("Failed to send milestone email", "error");
        }
      } else {
        // No email template — update status + completed_at
        await fetch("/api/admin/milestones", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, status: newStatus, completed_at: new Date().toISOString() }),
        });
      }
    } else {
      // Moving away from Completed — clear completed_at and reset email_sent
      await fetch("/api/admin/milestones", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: newStatus, completed_at: null, email_sent: false }),
      });
    }

    await refetchData();
  };

  const handleSendMilestoneEmail = async (milestoneId: string) => {
    const milestone = milestones.find((m) => m.id === milestoneId);
    if (milestone?.status !== "Completed") {
      alert("Email can only be sent for completed stages.");
      return;
    }
    const res = await fetch("/api/admin/send-milestone-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ milestoneId, dealId: deal.id }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.alreadySent ? "Email was already sent for this milestone." : "Milestone email sent successfully!");
      await refetchData();
    } else {
      showToast(data.error || "Failed to send milestone email", "error");
    }
  };

  const handleSortMilestones = () => {
    if (
      dragMilestoneItem.current === null ||
      dragMilestoneOverItem.current === null
    )
      return;
    const _milestones = [...milestones];
    const draggedItemContent = _milestones[dragMilestoneItem.current];
    _milestones.splice(dragMilestoneItem.current, 1);
    _milestones.splice(dragMilestoneOverItem.current, 0, draggedItemContent);
    dragMilestoneItem.current = dragMilestoneOverItem.current;
    dragMilestoneOverItem.current = null;
    setMilestones(_milestones);
  };

  // Tasks
  const handleTaskStatusChange = async (id: string, newStatus: Task["status"]) => {
    const isCompleted = newStatus === "Completed";
    const completedAt = isCompleted
      ? new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
      : undefined;

    // Optimistic local update
    const updatedTasks = tasks.map((t) =>
      t.id === id ? { ...t, status: newStatus, completed: isCompleted, completedAt } : t
    );
    setTasks(updatedTasks);

    // PATCH task in DB
    await fetch("/api/admin/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        status: newStatus,
        completed: isCompleted,
        completed_at: isCompleted ? new Date().toISOString() : null,
      }),
    });

    // Check if all tasks for this milestone are completed → auto-update milestone
    const task = updatedTasks.find((t) => t.id === id);
    if (task?.milestoneId) {
      const milestoneId = task.milestoneId;
      const milestoneTasks = updatedTasks.filter((t) => t.milestoneId === milestoneId);
      const allDone = milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === "Completed");
      const newMilestoneStatus = allDone ? "Completed" : milestoneTasks.some((t) => t.status === "In Progress" || t.status === "Completed") ? "In Progress" : "Pending";

      setMilestones((prev) =>
        prev.map((m) =>
          m.id === milestoneId
            ? { ...m, status: newMilestoneStatus as Milestone["status"], completedAt: allDone ? new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : undefined }
            : m
        )
      );

      if (allDone) {
        const milestone = milestones.find((m) => m.id === milestoneId);
        if (milestone?.emailTemplateId) {
          try {
            const res = await fetch("/api/admin/send-milestone-email", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ milestoneId, dealId: deal.id }),
            });
            const data = await res.json();
            if (data.success) {
              showToast(data.alreadySent ? "Email was already sent for this milestone." : "Milestone email sent successfully!");
            } else {
              showToast(data.error || "Failed to send milestone email", "error");
            }
          } catch {
            showToast("Failed to send milestone email", "error");
          }
        } else {
          await fetch("/api/admin/milestones", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: milestoneId, status: "Completed", completed_at: new Date().toISOString() }),
          });
        }
      } else {
        await fetch("/api/admin/milestones", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: milestoneId, status: newMilestoneStatus, completed_at: null, email_sent: false }),
        });
      }
    }

    // Re-fetch from DB to ensure UI reflects actual stored state
    await refetchData();
  };

  const handleSortTasks = () => {
    if (dragTaskItem.current === null || dragTaskOverItem.current === null)
      return;
    const _tasks = [...tasks];
    const draggedItemContent = _tasks[dragTaskItem.current];
    _tasks.splice(dragTaskItem.current, 1);
    _tasks.splice(dragTaskOverItem.current, 0, draggedItemContent);
    dragTaskItem.current = dragTaskOverItem.current;
    dragTaskOverItem.current = null;
    setTasks(_tasks);
  };

  const getStatusColor = (status: string | undefined) => {
    switch (status) {
      case "Completed":
        return "bg-green-50 text-green-700 border-green-200";
      case "In Progress":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "Pending":
        return "bg-yellow-50 text-yellow-700 border-yellow-200";
      default:
        return "bg-slate-50 text-slate-600 border-slate-200";
    }
  };

  const handleDeleteMilestone = async (milestoneId: string) => {
    if (!confirm("Are you sure you want to delete this stage?")) return;
    try {
      const res = await fetch(`/api/admin/milestones?id=${milestoneId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setMilestones(prev => prev.filter(m => m.id !== milestoneId));
      } else {
        alert('Failed to delete stage: ' + data.error);
      }
    } catch {
      alert('Error deleting stage.');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (!confirm("Are you sure you want to delete this task?")) return;
    try {
      const res = await fetch(`/api/admin/tasks?id=${taskId}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setTasks(prev => prev.filter(t => t.id !== taskId));
      } else {
        alert('Failed to delete task: ' + data.error);
      }
    } catch {
      alert('Error deleting task.');
    }
  };

  const getDisplayAddress = (address: string) => {
    return address.replace(/^(Purchase|Sale|Refinance) of\s+/i, "");
  };

  const handleSaveTask = async () => {
    if (!taskForm.title || !taskForm.client) return;

    try {
      // Build the task object to send
      const taskPayload = {
        deal_id: deal.id,
        title: taskForm.title,
        status: taskForm.status,
        due_date: taskForm.deadlineDate || null,
        assignee: taskForm.partner || null,
        task_template_id: taskTemplates.find(t => t.name === taskForm.title)?.id || null,
        milestone_id: taskForm.milestoneId || null,
        client: taskForm.client,
      };

      // Send POST request to API
      const response = await fetch("/api/admin/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(taskPayload),
      });

      // Parse JSON response
      const data = await response.json();

      if (data.success) {
        setTasks((prev) => [...prev, mapApiTask(data.data)]);

        // Reset form
        setShowTaskForm(false);
        setTaskForm({
          client: rawDeal?.client_id ?? "",
          partner: "",
          title: "",
          status: "Pending",
          deadlineDate: "",
          deadlineTime: "",
          milestoneId: "",
        });
      } else {
        alert("Failed to save task: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Error saving task.");
    }
  };

  const [showTaskForm, setShowTaskForm] = useState(false);

  const [taskForm, setTaskForm] = useState({
    client: rawDeal?.client_id ?? "",
    partner: "",
    title: "",
    status: "Pending",
    deadlineDate: "",
    deadlineTime: "",
    milestoneId: "",
  });

  const handleTaskFormChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setTaskForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const [clients, setClients] = useState<any[]>([]);
  const [taskTemplates, setTaskTemplates] = useState<any[]>([]);
  const [taskFileDocs, setTaskFileDocs] = useState<any[]>([]);
  const [taskDocsPopup, setTaskDocsPopup] = useState<{ taskTitle: string; docs: any[] } | null>(null);

  // Stage form state
  const [showStageForm, setShowStageForm] = useState(false);
  const [stageTemplates, setStageTemplates] = useState<any[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<any[]>([]);
  const [stageForm, setStageForm] = useState({
    stageTemplate: "",
    client: rawDeal?.client_id ?? "",
    status: "Pending",
    partner: "",
    milestoneDate: "",
    emailTemplateId: "",
  });

  const handleStageFormChange = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => {
    const { name, value } = e.target;
    if (name === "stageTemplate") {
      const selected = stageTemplates.find(t => t.name === value);
      setStageForm((prev) => ({
        ...prev,
        stageTemplate: value,
        emailTemplateId: selected?.email_template_id ?? "",
      }));
    } else {
      setStageForm((prev) => ({ ...prev, [name]: value }));
    }
  };

  const handleSaveStage = async () => {
    if (!stageForm.stageTemplate) return;

    try {
      const payload = {
        deal_id: deal.id,
        title: stageForm.stageTemplate,
        status: stageForm.status,
        milestone_date: stageForm.milestoneDate || null,
        email_template_id: stageForm.emailTemplateId || null,
      };

      const res = await fetch("/api/admin/milestones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (data.success) {
        const newMilestone: Milestone = {
          id: data.data.id,
          title: data.data.title,
          status: data.data.status ?? "Pending",
          milestoneDate: data.data.milestone_date ?? undefined,
          emailTemplateId: data.data.email_template_id ?? null,
        };
        setMilestones((prev) => [...prev, newMilestone]);
        setShowStageForm(false);
        setStageForm({ stageTemplate: "", client: rawDeal?.client_id ?? "", status: "Pending", partner: "", milestoneDate: "", emailTemplateId: "" });
      } else {
        alert("Failed to save stage: " + data.error);
      }
    } catch (err) {
      console.error(err);
      alert("Error saving stage.");
    }
  };

  // Fetch user-added tasks from DB
  useEffect(() => {
    fetch(`/api/admin/tasks?deal_id=${deal.id}`)
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setTasks(data.map(mapApiTask));
      })
      .catch(() => { });
  }, [deal.id]);

  // Fetch user-added milestones from DB
  useEffect(() => {
    fetch(`/api/admin/milestones?deal_id=${deal.id}`)
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) {
          setMilestones(data.map((m: any): Milestone => ({
            id: m.id,
            title: m.title,
            status: m.status ?? "",
            milestoneDate: m.milestone_date ?? undefined,
            completedAt: m.completed_at ?? undefined,
            emailSent: m.email_sent ?? false,
            emailTemplateId: m.email_template_id ?? null,
          })));
        }
      })
      .catch(() => { });
  }, [deal.id]);

  // Fetch task templates for predefined rows + add-task form
  useEffect(() => {
    fetch("/api/admin/task-templates")
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setTaskTemplates(data);
      })
      .catch(() => { });
  }, []);

  // Fetch stage templates for predefined rows + add-stage form
  useEffect(() => {
    fetch("/api/admin/milestone-templates")
      .then(res => res.json())
      .then((data: any[]) => {
        if (Array.isArray(data)) setStageTemplates(data);
      })
      .catch(() => { });
  }, []);

  // Combine predefined templates + user-added data for display (deduped by title)
  const dealType = deal.type?.toLowerCase();

  const displayTasks: DisplayTask[] = (() => {
    const userTitles = new Set(tasks.map(t => t.title.toLowerCase()));
    const templateRows: DisplayTask[] = taskTemplates
      .filter((t: any) => t.is_default)
      .filter((t: any) => !userTitles.has(t.name.toLowerCase()))
      .map((t: any): DisplayTask => ({
        id: `tpl-${t.id}`,
        title: t.name,
        completed: false,
        status: "Pending",
        isTemplate: true,
      }));
    const userRows: DisplayTask[] = tasks.map(t => ({ ...t, isTemplate: false }));
    return [...templateRows, ...userRows];
  })();

  const displayMilestones: DisplayMilestone[] = (() => {
    const userTitles = new Set(milestones.map(m => m.title.toLowerCase()));
    const templateRows: DisplayMilestone[] = stageTemplates
      .filter((t: any) => !dealType || t.lead_type?.toLowerCase() === dealType)
      .filter((t: any) => !userTitles.has(t.name.toLowerCase()))
      .map((t: any): DisplayMilestone => ({
        id: `tpl-${t.id}`,
        title: t.name,
        status: "Pending",
        isTemplate: true,
        emailTemplateId: t.email_template_id ?? null,
      }));
    const userRows: DisplayMilestone[] = milestones.map(m => ({ ...m, isTemplate: false }));
    return [...templateRows, ...userRows];
  })();

  useEffect(() => {
    async function fetchClients() {
      try {
        const res = await fetch("/api/admin/clients");
        const data = await res.json();
        console.log(data, "fetched clients");
        setClients(data);
      } catch (error) {
        console.error("Failed to fetch clients:", error);
      }
    }

    fetchClients();
  }, []);


  useEffect(() => {
    fetch("/api/admin/email-templates")
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setEmailTemplates(data); })
      .catch(() => { });
  }, []);


  useEffect(() => {
    fetch(`/api/admin/task-responses?deal_id=${deal.id}`)
      .then(res => res.json())
      .then(data => { if (Array.isArray(data)) setTaskFileDocs(data); })
      .catch(() => { });
  }, [deal.id]);

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Toast */}
      {toast && (
        <div
          className={`fixed top-6 right-6 z-50 px-5 py-3 rounded-lg shadow-lg text-sm font-medium text-white transition-all ${
            toast.type === "success" ? "bg-green-600" : "bg-red-600"
          }`}
        >
          {toast.message}
        </div>
      )}

      {/* Top Navigation & Actions */}
      <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <button
          onClick={handleBack}
          className="flex items-center text-slate-500 hover:text-slate-800 transition-colors font-medium"
        >
          <ArrowLeft size={20} className="mr-2" /> Back to files
        </button>

        <div className="flex gap-3">
          <button
            onClick={() => { setShowDocuments(true); fetchDealDocuments(); }}
            className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm flex items-center gap-2"
          >
            <FileText size={16} /> View Documents
          </button>
        </div>
      </div>

      {/* Property Details Card (Top - Full Width) */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6 mb-6">
        <div className="flex flex-col md:flex-row justify-between items-start gap-6">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-[10px] font-bold text-slate-600 uppercase tracking-wide">
                Property
              </span>
              <span className="inline-flex items-center px-2 py-0.5 bg-brand-light border border-brand-primary/20 rounded text-[10px] font-bold text-brand-primary uppercase tracking-wide">
                {deal.type}
              </span>
              <span className="text-xs font-medium text-slate-400 ml-1">
                {deal.fileNumber}
              </span>
            </div>

            <h1 className="text-2xl font-bold text-slate-900 mb-4 leading-tight">
              {getDisplayAddress(deal.propertyAddress)}
            </h1>

            <div className="flex flex-wrap gap-x-8 gap-y-4">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <Calendar size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Closing Date
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {deal.closingDate || "TBD"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <User size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Closing Manager
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    Suganya Argeen
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-50 border border-slate-100 flex items-center justify-center text-slate-400">
                  <CheckCircle size={14} />
                </div>
                <div>
                  <p className="text-[10px] uppercase font-bold text-slate-400 tracking-wider leading-none mb-1">
                    Deal Status
                  </p>
                  <p className="font-bold text-sm text-slate-900 leading-none">
                    {deal.status}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Icon */}
          <div className="hidden md:block opacity-5 text-slate-900">
            <Building2 size={80} />
          </div>
        </div>
      </div>

      <div className="space-y-8">
        {/* Tasks Section */}
        <div className="space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold text-slate-900">Tasks</h2>
            <button
              onClick={() => setShowTaskForm(true)}
              className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors"
            >
              <Plus size={14} className="mr-1" />
              Add Task
            </button>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-2 sm:px-3 py-3 w-8 hidden sm:table-cell"></th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-8 text-center">
                      #
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-24 sm:w-32">
                      Status
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider">
                      Task Name
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-12 sm:w-16">
                      Doc
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-20 hidden md:table-cell">
                      Deadline
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-28 hidden lg:table-cell">
                      Completed
                    </th>
                    <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-16 text-center">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {displayTasks.map((task, index) => (
                    <tr
                      key={task.id}
                      draggable={!task.isTemplate}
                      onDragStart={() => !task.isTemplate && (dragTaskItem.current = index)}
                      onDragEnter={() => !task.isTemplate && (dragTaskOverItem.current = index)}
                      onDragEnd={!task.isTemplate ? handleSortTasks : undefined}
                      onDragOver={(e) => e.preventDefault()}
                      className={`hover:bg-slate-50 transition-colors group ${task.isTemplate ? "opacity-60" : "cursor-move"}`}
                    >
                      <td className="px-2 sm:px-3 py-3 text-slate-300 hidden sm:table-cell">
                        {!task.isTemplate && <GripVertical size={16} />}
                      </td>
                      <td className="px-2 py-3 text-center text-xs text-slate-600 font-medium">
                        {index + 1}
                      </td>
                      <td className="px-2 py-3">
                        {task.isTemplate ? (
                          <span className={`text-xs font-semibold border rounded px-2 py-1 inline-block ${getStatusColor("Pending")}`}>
                            Pending
                          </span>
                        ) : (
                          <div className="relative">
                            <select
                              className={`text-xs font-semibold border rounded pl-2 pr-6 py-1 w-full outline-none cursor-pointer appearance-none truncate ${getStatusColor(task.status)}`}
                              value={task.status || "Pending"}
                              onChange={(e) =>
                                handleTaskStatusChange(
                                  task.id,
                                  e.target.value as any,
                                )
                              }
                            >
                              <option value="Pending">Pending</option>
                              <option value="Completed">Completed</option>
                            </select>
                            <div className="absolute inset-y-0 right-0 flex items-center pr-1.5 pointer-events-none text-slate-500">
                              <ChevronDown size={10} />
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <span className="text-sm font-semibold text-slate-800 block leading-tight">
                          {task.title}
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        {task.isTemplate ? (
                          <span className="text-slate-300 text-xs">-</span>
                        ) : (() => {
                          const matched = taskFileDocs.filter(d => d.task_id === task.id);
                          return matched.length > 0 ? (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                setTaskDocsPopup({ taskTitle: task.title, docs: matched });
                              }}
                              className="flex items-center gap-1.5 text-xs text-brand-primary hover:text-brand-primaryHover cursor-pointer relative z-10 bg-transparent border-none p-0 transition-colors"
                              title={`${matched.length} document${matched.length !== 1 ? "s" : ""}`}
                            >
                              <FileText size={14} className="shrink-0" />
                              <span className="font-medium">{matched.length}</span>
                            </button>
                          ) : (
                            <span className="text-slate-300 text-xs">-</span>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-3 hidden md:table-cell">
                        {task.isTemplate ? (
                          <span className="text-slate-300 text-xs">-</span>
                        ) : (
                          <div className="relative">
                            <input
                              type="date"
                              value={task.dueDate ?? ""}
                              onChange={async (e) => {
                                const newDate = e.target.value || null;
                                setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, dueDate: newDate ?? undefined } : t));
                                await fetch("/api/admin/tasks", {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ id: task.id, due_date: newDate }),
                                });
                              }}
                              className="absolute inset-0 opacity-0 cursor-pointer w-full"
                            />
                            {task.dueDate ? (
                              <span className="text-xs font-medium text-slate-700">
                                {new Date(task.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-3 hidden lg:table-cell">
                        <span className="text-xs text-slate-500">
                          {task.isTemplate
                            ? "-"
                            : task.completedAt
                              ? new Date(task.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                              : "-"}
                        </span>
                      </td>
                      <td className="px-2 py-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => openTaskView(task)} className="text-slate-400 hover:text-brand-primary p-1 transition-colors" title="View details">
                            <Eye size={16} />
                          </button>
                          {!task.isTemplate && (
                            <button onClick={() => handleDeleteTask(task.id)} className="text-slate-300 hover:text-red-600 p-1 transition-colors">
                              <Trash2 size={16} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                  {displayTasks.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-6 py-8 text-center text-slate-400 text-sm"
                      >
                        No tasks assigned.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Milestones & Partner Section */}
        <div className="space-y-6">
          {/* Milestones */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-900">Milestones</h2>
              <button
                onClick={() => setShowStageForm(true)}
                className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors"
              >
                <Plus size={14} className="mr-1" /> Add Stage
              </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-2 sm:px-3 py-3 w-8 hidden sm:table-cell"></th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-8 text-center">
                        #
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-24 sm:w-32">
                        Status
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider">
                        Milestone Name
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-20 hidden md:table-cell">
                        Deadline
                      </th>
                      <th className="px-2 py-3 text-xs font-bold text-slate-600 uppercase tracking-wider w-16 text-center">
                        Action
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {displayMilestones.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="text-center py-8 text-sm text-slate-400">
                          No milestones added
                        </td>
                      </tr>
                    ) : (
                      displayMilestones.map((milestone, index) => {
                        return (
                          <React.Fragment key={milestone.id}>
                            <tr
                              draggable={!milestone.isTemplate}
                              onDragStart={() => !milestone.isTemplate && (dragMilestoneItem.current = index)}
                              onDragEnter={() => !milestone.isTemplate && (dragMilestoneOverItem.current = index)}
                              onDragEnd={!milestone.isTemplate ? handleSortMilestones : undefined}
                              onDragOver={(e) => e.preventDefault()}
                              className={`hover:bg-slate-50 transition-colors group bg-white ${milestone.isTemplate ? "opacity-60" : "cursor-move"}`}
                            >
                              <td className="px-2 sm:px-3 py-3 text-slate-300 hidden sm:table-cell">
                                {!milestone.isTemplate && <GripVertical size={16} />}
                              </td>

                              <td className="px-2 py-3 text-center text-xs text-slate-600 font-medium">
                                {index + 1}
                              </td>

                              <td className="px-2 py-3">
                                {milestone.isTemplate ? (
                                  <span className={`text-xs font-semibold border rounded px-2 py-1 inline-block ${getStatusColor("Pending")}`}>
                                    Pending
                                  </span>
                                ) : (
                                  <div className="relative">
                                    <select
                                      className={`text-xs font-semibold border rounded pl-2 pr-6 py-1 w-full outline-none cursor-pointer appearance-none truncate ${getStatusColor(milestone.status)}`}
                                      value={milestone.status}
                                      onChange={(e) =>
                                        handleMilestoneStatusChange(
                                          milestone.id,
                                          e.target.value as any
                                        )
                                      }
                                    >
                                      <option value="">Status</option>
                                      <option value="Pending">Pending</option>
                                      <option value="In Progress">In Progress</option>
                                      <option value="Completed">Completed</option>
                                    </select>
                                    <div className="absolute inset-y-0 right-0 flex items-center pr-1.5 pointer-events-none text-slate-500">
                                      <ChevronDown size={10} />
                                    </div>
                                  </div>
                                )}
                              </td>

                              <td className="px-2 py-3">
                                <span className="text-sm text-slate-800 font-semibold">
                                  {milestone.title}
                                </span>
                              </td>

                              <td className="px-2 py-3 hidden md:table-cell">
                                {milestone.isTemplate ? (
                                  <span className="text-slate-300 text-xs">-</span>
                                ) : (
                                  <div className="relative">
                                    <input
                                      type="date"
                                      value={milestone.milestoneDate ?? ""}
                                      onChange={async (e) => {
                                        const newDate = e.target.value || null;
                                        setMilestones((prev) => prev.map((m) => m.id === milestone.id ? { ...m, milestoneDate: newDate ?? undefined } : m));
                                        await fetch("/api/admin/milestones", {
                                          method: "PATCH",
                                          headers: { "Content-Type": "application/json" },
                                          body: JSON.stringify({ id: milestone.id, milestone_date: newDate }),
                                        });
                                      }}
                                      className="absolute inset-0 opacity-0 cursor-pointer w-full"
                                    />
                                    {milestone.milestoneDate ? (
                                      <span className="text-xs font-medium text-slate-700">
                                        {new Date(milestone.milestoneDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                                      </span>
                                    ) : (
                                      <span className="text-xs text-slate-300">—</span>
                                    )}
                                  </div>
                                )}
                              </td>

                              <td className="px-2 py-3 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {milestone.emailTemplateId && (
                                    <button
                                      title={milestone.emailSent ? "Email already sent" : "Send Email"}
                                      onClick={() => handleSendMilestoneEmail(milestone.id)}
                                      className={`p-1 rounded transition-colors ${milestone.emailSent ? "text-green-600 hover:bg-green-50" : "text-brand-primary hover:bg-brand-light"}`}
                                    >
                                      <Mail size={14} />
                                    </button>
                                  )}
                                  <button onClick={() => handleDeleteMilestone(milestone.id)} className="text-slate-300 hover:text-red-600 p-1 rounded transition-colors">
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              </td>
                            </tr>

                          </React.Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Partner Details */}
          <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
            <h3 className="font-bold text-slate-800 mb-4 text-sm">
              Partner Details
            </h3>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-slate-900 text-white rounded-lg flex items-center justify-center font-black text-xs shadow-md">
                KW
              </div>
              <div>
                <p className="text-sm font-bold text-slate-900">
                  Keller Williams
                </p>
                <p className="text-xs text-slate-500">Real Estate Brokerage</p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <p className="text-[10px] text-slate-500 font-medium mb-0.5 uppercase tracking-wide">
                  Agent
                </p>
                <p className="font-bold text-slate-800 text-xs">Sarah Connor</p>
              </div>
              <div className="bg-slate-50 p-3 rounded-lg border border-slate-100">
                <p className="text-[10px] text-slate-500 font-medium mb-0.5 uppercase tracking-wide">
                  Email
                </p>
                <a
                  href="#"
                  className="font-bold text-brand-primary hover:underline truncate block text-xs"
                >
                  sarah@kw.com
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
      {showStageForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-6">Add Stage</h3>

            <div className="space-y-4">
              {/* Stage Template */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Stage Template
                </label>
                <select
                  name="stageTemplate"
                  value={stageForm.stageTemplate}
                  onChange={handleStageFormChange}
                  className="flex-1 min-w-0 w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="">Select Stage Template</option>
                  {stageTemplates
                    .filter((t) => !deal.type || t.lead_type?.toLowerCase() === deal.type.toLowerCase())
                    .map((t) => {
                    const label = `${t.lead_type}-${t.role}-${t.name}`;
                    return (
                      <option key={t.id} value={t.name} title={label}>
                        {label.length > 55 ? label.slice(0, 55) + "…" : label}
                      </option>
                    );
                  })}
                </select>
              </div>

              {/* Client */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Client
                </label>
                <select
                  name="client"
                  value={stageForm.client}
                  onChange={handleStageFormChange}
                  className="flex-1 min-w-0 w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="">Select Client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.first_name} {client.last_name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Status */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Status
                </label>
                <select
                  name="status"
                  value={stageForm.status}
                  onChange={handleStageFormChange}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="Pending">Pending</option>
                  <option value="In Progress">In Progress</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>

              {/* Partner */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Partner
                </label>
                <select
                  name="partner"
                  value={stageForm.partner}
                  onChange={handleStageFormChange}
                  className="flex-1 min-w-0 w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="">Select Partner</option>
                </select>
              </div>

              {/* Closing Date */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Closing Date
                </label>
                <input
                  type="date"
                  name="milestoneDate"
                  value={stageForm.milestoneDate}
                  onChange={handleStageFormChange}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                />
              </div>

              {/* Email Template */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Email Template
                </label>
                <select
                  name="emailTemplateId"
                  value={stageForm.emailTemplateId}
                  onChange={handleStageFormChange}
                  disabled={!stageForm.emailTemplateId}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none disabled:bg-slate-100 disabled:text-slate-400"
                >
                  {stageForm.emailTemplateId ? (
                    emailTemplates
                      .filter(t => t.id === stageForm.emailTemplateId)
                      .map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))
                  ) : (
                    <option value="">No email template</option>
                  )}
                </select>
              </div>

              {/* Buttons */}
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowStageForm(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveStage}
                  className="px-4 py-2 bg-brand-primary text-white rounded-lg text-sm font-medium hover:bg-brand-primaryHover"
                >
                  Save Stage
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showTaskForm && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">

            <h3 className="text-lg font-bold text-slate-900 mb-6">
              Add Task
            </h3>

            <div className="space-y-4">

              {/* Client */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Client
                </label>

                <div className="flex items-center gap-2 mt-1 min-w-0">
                  <select
                    name="client"
                    value={taskForm.client}
                    onChange={handleTaskFormChange}
                    className="flex-1 min-w-0 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                  >
                    <option value="">Select Client</option>

                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.first_name} {client.last_name}
                      </option>
                    ))}
                  </select>

                  {/* <button className="text-slate-400 hover:text-slate-700">
                    <Pencil size={16} />
                  </button>

                  <button className="text-green-600 hover:text-green-700">
                    <Plus size={16} />
                  </button>

                  <button className="text-slate-400 hover:text-slate-700">
                    <Eye size={16} />
                  </button> */}
                </div>
              </div>

              {/* Partner */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Partner
                </label>

                <div className="flex items-center gap-2 mt-1 min-w-0">
                  <select
                    name="partner"
                    value={taskForm.partner}
                    onChange={handleTaskFormChange}
                    className="flex-1 min-w-0 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                  >
                    <option value="">Select Partner</option>
                    {/* <option value="partner1">Partner 1</option>
                    <option value="partner2">Partner 2</option> */}
                  </select>

                  {/* <button className="text-slate-400 hover:text-slate-700">
                    <Pencil size={16} />
                  </button>

                  <button className="text-green-600 hover:text-green-700">
                    <Plus size={16} />
                  </button>

                  <button className="text-slate-400 hover:text-slate-700">
                    <Eye size={16} />
                  </button> */}
                </div>
              </div>

              {/* Task Template */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Task Template
                </label>

                <div className="flex items-center gap-2 mt-1 min-w-0">
                  <select
                    name="title"
                    value={taskForm.title}
                    onChange={handleTaskFormChange}
                    className="flex-1 min-w-0 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                  >
                    <option value="">Select Task Template</option>

                    {taskTemplates.map((template) => {
                      const label = `${template.lead_type} - ${template.role_type} - ${template.name}`;
                      return (
                        <option key={template.id} value={template.name} title={label}>
                          {label.length > 55 ? label.slice(0, 55) + '…' : label}
                        </option>
                      );
                    })}
                  </select>

                  {/* <button className="text-slate-400 hover:text-slate-700">
                    <Pencil size={16} />
                  </button>

                  <button className="text-green-600 hover:text-green-700">
                    <Plus size={16} />
                  </button>

                  <button className="text-slate-400 hover:text-slate-700">
                    <Eye size={16} />
                  </button> */}
                </div>
              </div>

              {/* Status */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Status
                </label>
                <select
                  name="status"
                  value={taskForm.status}
                  onChange={handleTaskFormChange}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="Pending">Pending</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>

              {/* Deadline */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">
                    Deadline Date
                  </label>

                  <div className="relative mt-1">
                    <Calendar
                      size={16}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
                    />

                    <input
                      type="date"
                      name="deadlineDate"
                      value={taskForm.deadlineDate}
                      onChange={handleTaskFormChange}
                      className="w-full border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:border-brand-primary outline-none"
                    />
                  </div>
                </div>

              </div>

              {/* Milestone */}
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">
                  Milestone
                </label>
                <select
                  name="milestoneId"
                  value={taskForm.milestoneId}
                  onChange={handleTaskFormChange}
                  className="w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm focus:border-brand-primary outline-none"
                >
                  <option value="">No Milestone</option>
                  {milestones.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
              </div>

              {/* Buttons */}
              <div className="flex justify-end gap-3 mt-6">
                <button
                  onClick={() => setShowTaskForm(false)}
                  className="px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>

                <button
                  onClick={handleSaveTask}
                  className="px-4 py-2 bg-brand-primary text-white rounded-lg text-sm font-medium hover:bg-brand-primaryHover"
                >
                  Save Task
                </button>
              </div>

            </div>
          </div>

        </div>
      )}
      {/* Documents Modal */}
      {showDocuments && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Documents</h3>
              <button
                onClick={() => setShowDocuments(false)}
                className="text-slate-400 hover:text-slate-600 text-xl font-bold"
              >
                &times;
              </button>
            </div>
            <div className="px-6 py-4 overflow-y-auto flex-1">
              {loadingDocs ? (
                <p className="text-sm text-slate-400 text-center py-8">Loading documents...</p>
              ) : dealDocuments.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-8">No documents uploaded yet.</p>
              ) : (
                <div className="space-y-5">
                  {Object.entries(
                    dealDocuments.reduce((acc: Record<string, any[]>, doc) => {
                      const key = doc.task_title || "Unknown Task";
                      if (!acc[key]) acc[key] = [];
                      acc[key].push(doc);
                      return acc;
                    }, {})
                  ).map(([taskTitle, docs]) => (
                    <div key={taskTitle}>
                      <h4 className="text-sm font-bold text-slate-700 mb-2">{taskTitle}</h4>
                      <ul className="space-y-2">
                        {docs.map((doc: any, idx: number) => (
                          <li key={`${doc.task_id}-${idx}`} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                            <div className="flex items-center gap-3 min-w-0">
                              <FileText size={16} className="text-slate-400 shrink-0" />
                              <p className="text-sm font-medium text-slate-800 truncate">{doc.file_name}</p>
                            </div>
                            {doc.file_url ? (
                              <a
                                href={doc.file_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-medium text-brand-primary hover:underline shrink-0 ml-3"
                              >
                                View
                              </a>
                            ) : (
                              <span className="text-xs text-slate-400 shrink-0 ml-3">No file</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Task Documents Popup */}
      {taskDocsPopup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-slate-900">Documents</h3>
                <p className="text-xs text-slate-500 truncate mt-0.5">{taskDocsPopup.taskTitle}</p>
              </div>
              <button
                onClick={() => setTaskDocsPopup(null)}
                className="text-slate-400 hover:text-slate-600 text-xl font-bold shrink-0 ml-3"
              >
                &times;
              </button>
            </div>
            <div className="px-5 py-4 overflow-y-auto flex-1">
              <ul className="space-y-2">
                {taskDocsPopup.docs.map((doc: any, i: number) => (
                  <li key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-100">
                    <div className="flex items-center gap-3 min-w-0">
                      <FileText size={16} className="text-slate-400 shrink-0" />
                      <p className="text-sm font-medium text-slate-800 truncate">{doc.file_name}</p>
                    </div>
                    {doc.file_url ? (
                      <a
                        href={doc.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-medium text-brand-primary hover:underline shrink-0 ml-3"
                      >
                        View
                      </a>
                    ) : (
                      <span className="text-xs text-slate-400 shrink-0 ml-3">No file</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* View Task Detail Modal */}
      {viewingTask && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => setViewingTask(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
              <h3 className="text-lg font-bold text-slate-900">Task Details</h3>
              <button onClick={() => setViewingTask(null)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <span className="sr-only">Close</span>&times;
              </button>
            </div>
            <div className="px-6 py-5 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Task Name</p>
                <p className="text-sm font-semibold text-slate-800 mt-0.5">{viewingTask.title}</p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Status</p>
                  <span className={`inline-block mt-1 text-xs font-semibold border rounded px-2 py-1 ${getStatusColor(viewingTask.status || "Pending")}`}>
                    {viewingTask.status || "Pending"}
                  </span>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Due Date</p>
                  <p className="text-sm text-slate-700 mt-0.5">
                    {viewingTask.dueDate
                      ? new Date(viewingTask.dueDate).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Completed At</p>
                  <p className="text-sm text-slate-700 mt-0.5">
                    {viewingTask.completedAt
                      ? new Date(viewingTask.completedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">Milestone</p>
                  <p className="text-sm text-slate-700 mt-0.5">
                    {viewingTask.milestoneId
                      ? milestones.find((m) => m.id === viewingTask.milestoneId)?.title || "—"
                      : "—"}
                  </p>
                </div>
              </div>

              {/* Client-submitted responses */}
              <div className="border-t border-slate-100 pt-4">
                <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold mb-3">Client Responses</p>
                {loadingTaskResponses ? (
                  <div className="flex items-center gap-2 py-4">
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-brand-primary"></div>
                    <span className="text-xs text-slate-400">Loading...</span>
                  </div>
                ) : viewTaskResponses.length > 0 ? (
                  <div className="space-y-3">
                    {viewTaskResponses.map((resp: any, i: number) => (
                      <div key={i} className="bg-slate-50 rounded-lg px-4 py-3">
                        <p className="text-[11px] uppercase tracking-wider text-slate-400 font-bold">
                          {resp.field_label || resp.field_name || `Field ${i + 1}`}
                        </p>
                        {resp.field_type === "file" ? (
                          <div className="flex items-center gap-2 mt-1">
                            <FileText size={14} className="text-brand-primary shrink-0" />
                            {resp.file_url ? (
                              <a href={resp.file_url} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-primary hover:underline truncate">
                                {resp.file_name || "View file"}
                              </a>
                            ) : (
                              <span className="text-sm text-slate-500">{resp.file_name || "File uploaded (no URL)"}</span>
                            )}
                          </div>
                        ) : (
                          <p className="text-sm text-slate-700 mt-0.5 break-words">
                            {resp.value || resp.text_value || "—"}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400 italic">No responses submitted yet.</p>
                )}
              </div>
            </div>
            <div className="px-6 py-3 border-t border-slate-100 flex justify-end">
              <button onClick={() => setViewingTask(null)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DealDetail;
