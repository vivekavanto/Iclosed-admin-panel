"use client";

import React, { useState, useRef } from "react";
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
} from "lucide-react";
import { useRouter } from "next/navigation";

interface DealDetailProps {
  deal: Deal;
  onBack?: () => void;
}

const DealDetail: React.FC<DealDetailProps> = ({ deal, onBack }) => {
  const router = useRouter();
  const handleBack = onBack || (() => router.push("/deals"));

  // Use state to allow modification simulation
  const [tasks, setTasks] = useState<Task[]>(deal.tasks || []);
  const [milestones, setMilestones] = useState<Milestone[]>(
    deal.milestones || [],
  );

  // Drag and Drop State
  const dragTaskItem = useRef<number | null>(null);
  const dragTaskOverItem = useRef<number | null>(null);
  const dragMilestoneItem = useRef<number | null>(null);
  const dragMilestoneOverItem = useRef<number | null>(null);

  // --- Handlers ---

  // Milestones
  const handleMilestoneStatusChange = (
    id: string,
    newStatus: Milestone["status"],
  ) => {
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
  const handleTaskStatusChange = (id: string, newStatus: Task["status"]) => {
    setTasks((prev) =>
      prev.map((t) => {
        if (t.id === id) {
          const isCompleted = newStatus === "Completed";
          return {
            ...t,
            status: newStatus,
            completed: isCompleted,
            completedAt: isCompleted
              ? new Date().toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : undefined,
          };
        }
        return t;
      }),
    );
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

  const getDisplayAddress = (address: string) => {
    return address.replace(/^(Purchase|Sale|Refinance) of\s+/i, "");
  };

  return (
    <div className="flex flex-col h-full bg-slate-50">
      {/* Top Navigation & Actions */}
      <div className="mb-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <button
          onClick={handleBack}
          className="flex items-center text-slate-500 hover:text-slate-800 transition-colors font-medium"
        >
          <ArrowLeft size={20} className="mr-2" /> Back to files
        </button>

        <div className="flex gap-3">
          <button className="bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-sm">
            View Documents
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

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-8 items-start">
        {/* Left Column - Tasks */}
        <div className="flex-1 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-bold text-slate-900">Tasks</h2>
            <button className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors">
              <Plus size={14} className="mr-1" /> Add Task
            </button>
          </div>

          <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left min-w-[600px]">
                <thead className="bg-slate-50 border-b border-slate-200">
                  <tr>
                    <th className="px-3 py-2 w-8"></th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-8 text-center">
                      #
                    </th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-32">
                      Status
                    </th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider min-w-[180px]">
                      Task Name
                    </th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-12 text-center">
                      Doc
                    </th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-20">
                      Deadline
                    </th>
                    <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-28">
                      Completed
                    </th>
                    <th className="px-2 py-2 w-8"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {tasks.map((task, index) => (
                    <tr
                      key={task.id}
                      draggable
                      onDragStart={() => (dragTaskItem.current = index)}
                      onDragEnter={() => (dragTaskOverItem.current = index)}
                      onDragEnd={handleSortTasks}
                      onDragOver={(e) => e.preventDefault()}
                      className="hover:bg-slate-50 transition-colors group cursor-move"
                    >
                      <td className="px-3 py-2 text-slate-300">
                        <GripVertical size={14} />
                      </td>
                      <td className="px-2 py-2 text-center text-[10px] text-slate-500 font-medium">
                        {index + 1}
                      </td>
                      <td className="px-2 py-2">
                        <div className="relative">
                          <select
                            className={`text-[10px] font-medium border rounded pl-2 pr-6 py-1 w-full outline-none cursor-pointer appearance-none truncate ${getStatusColor(task.status)}`}
                            value={task.status || "Pending"}
                            onChange={(e) =>
                              handleTaskStatusChange(
                                task.id,
                                e.target.value as any,
                              )
                            }
                          >
                            <option value="Pending">Pending</option>
                            <option value="In Progress">In Progress</option>
                            <option value="Completed">Completed</option>
                          </select>
                          <div className="absolute inset-y-0 right-0 flex items-center pr-1.5 pointer-events-none text-slate-500">
                            <ChevronDown size={10} />
                          </div>
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <span className="text-xs font-medium text-slate-800 block leading-tight">
                          {task.title}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        {task.document ? (
                          <a
                            href={task.document.url}
                            title={task.document.name}
                            className="inline-flex items-center justify-center text-brand-primary hover:text-brand-primaryHover"
                          >
                            <FileText size={14} />
                          </a>
                        ) : (
                          <span className="text-slate-300 text-[10px]">-</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="date"
                          defaultValue={task.dueDate}
                          className="text-[10px] border border-slate-200 rounded px-1 py-0.5 text-slate-600 bg-transparent focus:bg-white focus:border-brand-primary outline-none w-full"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <span className="text-[10px] text-slate-400">
                          {task.completedAt || "-"}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center">
                        <button className="text-slate-300 hover:text-red-600 p-1 transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {tasks.length === 0 && (
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

        {/* Right Column - Milestones & Partner */}
        <div className="flex-1 space-y-6">
          {/* Milestones */}
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-900">Milestones</h2>
              <button className="text-brand-primary text-xs font-bold flex items-center hover:bg-brand-light px-2 py-1 rounded transition-colors">
                <Plus size={14} className="mr-1" /> Add Stage
              </button>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left min-w-[500px]">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 w-8"></th>
                      <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-8 text-center">
                        #
                      </th>
                      <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-32">
                        Status
                      </th>
                      <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        Milestone Name
                      </th>
                      <th className="px-2 py-2 text-[10px] font-bold text-slate-500 uppercase tracking-wider w-20">
                        Deadline
                      </th>
                      <th className="px-2 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {milestones.map((milestone, index) => (
                      <tr
                        key={milestone.id}
                        draggable
                        onDragStart={() => (dragMilestoneItem.current = index)}
                        onDragEnter={() =>
                          (dragMilestoneOverItem.current = index)
                        }
                        onDragEnd={handleSortMilestones}
                        onDragOver={(e) => e.preventDefault()}
                        className="hover:bg-slate-50 transition-colors group cursor-move"
                      >
                        <td className="px-3 py-2 text-slate-300">
                          <GripVertical size={14} />
                        </td>
                        <td className="px-2 py-2 text-center text-[10px] text-slate-500 font-medium">
                          {index + 1}
                        </td>
                        <td className="px-2 py-2">
                          <div className="relative">
                            <select
                              className={`text-[10px] font-medium border rounded pl-2 pr-6 py-1 w-full outline-none cursor-pointer appearance-none truncate ${getStatusColor(milestone.status)}`}
                              value={milestone.status}
                              onChange={(e) =>
                                handleMilestoneStatusChange(
                                  milestone.id,
                                  e.target.value as any,
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
                        </td>
                        <td className="px-2 py-2">
                          <span className="text-xs text-slate-800 font-medium">
                            {milestone.title}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <input
                            type="date"
                            defaultValue={milestone.milestoneDate}
                            className="text-[10px] border border-slate-200 rounded px-1 py-0.5 text-slate-600 bg-transparent focus:bg-white focus:border-brand-primary outline-none w-full"
                          />
                        </td>
                        <td className="px-2 py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              title="Send Email"
                              className="text-brand-primary hover:bg-brand-light p-1 rounded transition-colors"
                            >
                              <Mail size={12} />
                            </button>
                            <button className="text-slate-300 hover:text-red-600 p-1 rounded transition-colors">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
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
    </div>
  );
};

export default DealDetail;
