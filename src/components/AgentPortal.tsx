"use client";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/AuthProvider";
import { hasModule } from "@/lib/staffAccess";
import { upload } from "@vercel/blob/client";
import { ArrowLeft, Bell, CheckCircle2, Circle, ChevronDown, ChevronRight, Eye, Loader2, Lock, LogIn, Mail, PencilLine, RotateCw, Save, Search, Trash2, Upload, X } from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";
import { BLOB_ACCESS, docDownloadHref } from "@/lib/blobPrivacy";
import {
  daysBetween,
  type ClubbedTask,
  type PortalFile,
  type PortalSection,
  type PortalSide,
  type PortalStage,
  type PortalStep,
  type StageStatus,
  AGENT_UPLOAD_PREFIX,
} from "@/lib/agentPortal";
import type { AgentDocument, AgentNote } from "@/lib/agentFileExtras";
import { allowedUploadContentTypesForDocType, formatFileSize, maxUploadBytesForDocType } from "@/lib/uploadValidation";

/** Lets a file card act as the agent and refresh the dashboard afterwards. */
const TaskContext = createContext<{ partnerId: string; reload: () => void } | null>(null);
const JourneyFileContext = createContext<{ rootLeadId: string; locked: boolean; status: string | null } | null>(null);

type Partner = {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
};

type Template = { id: string; name: string; lead_type: string };

type View = "file" | "notifications";

/** One side of one file; a Purchase & Sale file gives two rows. */
type Row = { id: string; file: PortalFile; section: PortalSection };

const STORAGE_KEY = "agentPortal.partnerId";

const TONE: Record<StageStatus, { bar: string; text: string; dot: string; pill: string; label: string }> = {
  complete: { bar: "bg-emerald-500", text: "text-slate-700", dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700", label: "Complete" },
  attention: { bar: "bg-slate-500", text: "text-slate-700", dot: "bg-slate-700", pill: "bg-slate-100 text-slate-700", label: "Needs attention" },
  progress: { bar: "bg-slate-500", text: "text-slate-700", dot: "bg-slate-400", pill: "bg-slate-100 text-slate-600", label: "In progress" },
  not_started: { bar: "bg-slate-300", text: "text-slate-400", dot: "bg-slate-300", pill: "bg-slate-50 text-slate-400", label: "Not started" },
};

const SIDE_BADGE: Record<PortalSide, string> = {
  purchase: "bg-slate-50 text-slate-600 border-slate-200",
  sale: "bg-slate-50 text-slate-600 border-slate-200",
  other: "bg-slate-50 text-slate-600 border-slate-200",
};

const isClosed = (f: PortalFile) => f.status === "Closed" || f.status === "Cancelled";
// The agent can't ask for permission or edit tasks on these; the server enforces it too.
const isLocked = (f: PortalFile) => isClosed(f) || f.status === "Inactive";

// A click that ends a text selection shouldn't toggle, so text stays copyable.
const selecting = () => !!window.getSelection()?.toString();

function clickable(onClick: () => void) {
  return {
    role: "button" as const,
    tabIndex: 0,
    onClick: () => !selecting() && onClick(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick();
      }
    },
  };
}

// Admin-side preview of the agent portal. Agents will eventually log in and see
// exactly this for themselves; until then staff pick an agent to test as.
const AgentPortal: React.FC = () => {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [partnerId, setPartnerId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/agent-portal");
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        setPartners(data.partners);
        let saved = "";
        try {
          saved = localStorage.getItem(STORAGE_KEY) ?? "";
        } catch {}
        if (saved && data.partners.some((p: Partner) => p.id === saved)) setPartnerId(saved);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const pick = (id: string) => {
    setPartnerId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
  };

  const partner = partners.find((p) => p.id === partnerId) ?? null;

  return (
    <div className="space-y-5 animate-in fade-in duration-300">
      <div className="flex flex-col gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
        <span className="flex items-center gap-2">
          <Eye size={16} className="shrink-0" />
          Staff preview: pick an agent to see their portal.
        </span>
        <select
          value={partnerId}
          onChange={(e) => pick(e.target.value)}
          className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 md:w-96"
        >
          <option value="">Select an agent…</option>
          {partners.map((p) => (
            <option key={p.id} value={p.id}>
              {p.agent_name || "(no name)"} · {p.referral_code ?? "no code"}
              {p.agent_email ? ` · ${p.agent_email}` : ""}
            </option>
          ))}
        </select>
      </div>

      {error && <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}

      {partner ? (
        <Portal key={partner.id} partner={partner} />
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center text-slate-500">Pick an agent above to see their portal.</div>
      )}
    </div>
  );
};

function Portal({ partner }: { partner: Partner }) {
  const [files, setFiles] = useState<PortalFile[] | null>(null);
  const [today, setToday] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("file");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);
  const taskContext = useMemo(
    () => ({ partnerId: partner.id, reload: () => setVersion((v) => v + 1) }),
    [partner.id],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/agent-portal/${partner.id}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        if (cancelled) return;
        setFiles(data.files);
        setToday(data.today);
        // Files needing attention open by default; the rest start collapsed.
        const open = new Set<string>();
        for (const f of data.files as PortalFile[]) for (const s of f.sections) if (s.attention) open.add(`${f.rootLeadId}:${s.side}`);
        // A reload after a task change keeps whatever the viewer has open.
        if (version === 0) setExpanded(open);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [partner.id, version]);

  const rows = useMemo<Row[]>(() => (files ?? []).flatMap((file) => file.sections.map((section) => ({ id: `${file.rootLeadId}:${section.side}`, file, section }))), [files]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => !q || [r.file.fileNumber, r.section.address, ...r.file.clients].some((v) => (v ?? "").toLowerCase().includes(q)));
  }, [rows, search]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const stats = useMemo(() => {
    const all = files ?? [];
    const active = all.filter((f) => !isClosed(f));
    return [
      { label: "Files", value: all.length },
      {
        label: "Closing in 30 days",
        value: active.filter((f) => f.closingDate && today && daysBetween(today, f.closingDate) >= 0 && daysBetween(today, f.closingDate) <= 30).length,
      },
    ];
  }, [files, today]);

  return (
    <TaskContext.Provider value={taskContext}>
      <div className="space-y-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Agent portal</p>
            <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
              {partner.agent_name}
              {partner.brokerage_name && <span className="ml-2 text-lg font-normal text-slate-500 md:text-xl">{partner.brokerage_name}</span>}
            </h1>
          </div>
          {/* Files are the default view; Notifications is the one place to step away to. */}
          <button
            type="button"
            onClick={() => setView(view === "file" ? "notifications" : "file")}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-slate-600 transition-colors hover:text-brand-primary"
          >
            {view === "file" ? <Bell size={14} /> : <ArrowLeft size={14} />}
            {view === "file" ? "Notifications" : "Back to files"}
          </button>
        </div>

        {view === "notifications" ? (
          <NotificationSettings partnerId={partner.id} />
        ) : error ? (
          <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>
        ) : !files ? (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 className="animate-spin" size={16} /> Loading files…
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {stats.map((s) => (
                <div key={s.label} className="inline-flex h-8 items-center gap-2 rounded-md bg-brand-primary px-3 text-white">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-white/80">{s.label}</span>
                  <span className="text-sm font-bold">{s.value}</span>
                </div>
              ))}
            </div>

            <div className="relative">
                <input
                  type="text"
                  placeholder="Search client, address or file number…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
                />
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            </div>

            {visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
                {files.length === 0 ? "No referred files yet." : "No files match this search."}
              </div>
            ) : (
              <div className="space-y-3">
                {visible.map((r) => (
                  <FileCard
                    key={r.id}
                    row={r}
                    open={expanded.has(r.id)}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </TaskContext.Provider>
  );
}

function SideBadge({ side, label }: { side: PortalSide; label: string }) {
  return <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SIDE_BADGE[side]}`}>{label}</span>;
}

function StageBar({ stages }: { stages: PortalStage[] }) {
  return (
    <div className={`grid grid-cols-2 gap-x-2 gap-y-3 sm:grid-cols-4 ${stages.length === 8 ? "xl:grid-cols-8" : "md:grid-cols-6"}`}>
      {stages.map((s) => (
        <div key={s.id} className="min-w-0">
          <div className="h-1.5 rounded-full bg-slate-200">
            <div className={`h-1.5 rounded-full ${TONE[s.status].bar}`} style={{ width: `${s.total ? (s.done / s.total) * 100 : 0}%` }} />
          </div>
          <div className="mt-1 flex items-center justify-between gap-1 text-[11px]">
            <span className={`truncate ${TONE[s.status].text}`}>{s.short}</span>
            <span className="font-mono text-slate-400">
              {s.done}/{s.total}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function FileCard({
  row,
  open,
  onToggle,
}: {
  row: Row;
  open: boolean;
  onToggle: () => void;
}) {
  const { file, section } = row;
  // Closed, Cancelled and Inactive files are grey whatever their tasks say.
  const pill = isLocked(file)
    ? { pill: "bg-slate-100 text-slate-600", label: file.status ?? "Inactive" }
    : section.attention
      ? TONE.attention
      : { pill: "bg-emerald-50 text-emerald-700", label: file.status ?? "Active" };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div {...clickable(onToggle)} className="w-full cursor-pointer px-4 py-4 text-left md:px-5" aria-expanded={open}>
        <div className="flex items-start gap-2">
          <span className="mt-1 text-slate-400">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-slate-900 md:text-lg">{file.clients.join(" & ") || "Unnamed client"}</span>
                  <SideBadge side={section.side} label={section.label} />
                  <PermissionActions file={file} />
                </div>
                <p className="mt-0.5 text-sm text-slate-500">
                  {file.fileNumber ?? "No file number"}
                  {section.address ? ` · ${section.address}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-sm md:flex-col md:items-end md:gap-1">
                <span className="flex items-center gap-1.5">
                  {/* Whether the agent can only follow the file, or also work its tasks in the client portal. */}
                  {file.permission.status === "granted" && !isLocked(file) ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-700">
                      <PencilLine size={11} /> Update tasks
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-500">
                      <Eye size={11} /> View tasks
                    </span>
                  )}
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.pill}`}>{pill.label}</span>
                </span>
                {file.closingDate && (
                  <span className="text-slate-500">
                    Closing {formatLocalDate(file.closingDate)}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-3">
              <StageBar stages={section.stages} />
            </div>
            {!open && section.nextUp && (
              <p className="mt-3 text-sm text-slate-500">
                Next up <span className="font-semibold text-slate-800">{section.nextUp}</span> · {section.pendingTasks} pending
              </p>
            )}
          </div>
        </div>
      </div>
      {open && (
        <div className="space-y-1 border-t border-slate-100 px-2 py-3 md:px-5">
          <JourneyFileContext.Provider value={{rootLeadId: file.rootLeadId, locked: isLocked(file), status: file.status}}>
            {section.stages.map((s) => (
              <StageRow key={s.id} stage={s} defaultOpen={section.side === "purchase" ? s.id === (section.stages.find(stage => stage.done < stage.total) ?? section.stages[0])?.id : s.status !== "complete"} />
            ))}
          </JourneyFileContext.Provider>
          <FileExtras rootLeadId={file.rootLeadId} />
        </div>
      )}
    </div>
  );
}

function StageRow({ stage, defaultOpen }: { stage: PortalStage; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = stage.steps;
  if (steps.length === 0) return null;
  const tone = TONE[stage.status];
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50" aria-expanded={open}>
        <span className="text-slate-400">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
        <span className="font-semibold text-slate-900">{stage.label}</span>
        <span className={`hidden rounded-full px-2 py-0.5 text-xs font-medium sm:inline ${tone.pill}`}>{tone.label}</span>
        <span className="ml-auto font-mono text-xs text-slate-400">
          {stage.done} / {stage.total}
        </span>
      </button>
      {open && (
        <ul className="mb-2 ml-6 divide-y divide-slate-100 md:ml-8">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TaskMeta({ task }: { task: ClubbedTask | null }) {
  if (!task || task.completed) return null;
  return (
    <>
      {task.total > 1 && <span className="text-xs text-slate-500">{task.done} of {task.total} clients</span>}
      {task.waitingOn.length > 0 && task.total > 1 && <span className="text-xs text-slate-500">Waiting on {task.waitingOn.join(", ")}</span>}
      {task.dueDate && <span className="text-xs text-slate-500">Due {formatLocalDate(task.dueDate)}</span>}
    </>
  );
}

function StepIcon({ done, size }: { done: boolean; size: number }) {
  if (done) return <CheckCircle2 size={size} className="shrink-0 text-emerald-600" />;
  return <Circle size={size} className="shrink-0 text-slate-300" />;
}

function StepRow({ step }: { step: PortalStep }) {
  const subTasks = step.subTasks;
  const [open, setOpen] = useState(!step.responsible);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ctx = useContext(TaskContext);
  const file = useContext(JourneyFileContext);
  const { user } = useAuth();
  const canTrack = (hasModule(user, "tasks") || hasModule(user, "deals")) && !!file && (!file.locked || (file.status === "Closed" && ["keys", "ownership"].includes(step.trackingKey ?? "")));
  const updateTracking = async (completed = !step.completed, responsible = step.responsible) => {
    if (!ctx || !file || !step.trackingKey) return;
    setBusy(true); setError("");
    try {
      const res = await fetch(`/api/admin/agent-portal/${ctx.partnerId}/files/${file.rootLeadId}/journey`, {
        method: "PUT", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({key: step.trackingKey, completed, expectedCompletedAt: step.completedAt, ...(step.trackingKey === "ownership" ? {responsible} : {})}),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw Error(data.error || "Could not update progress");
      ctx.reload();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return (
    <li className="py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">
          <StepIcon done={step.completed} size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
            className={`inline-flex items-center gap-1.5 text-left text-sm ${step.completed ? "text-slate-500" : "font-medium text-slate-900"}`}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{step.title}
          </button>
          {step.responsible && <span className="text-xs text-slate-500">{step.responsible}</span>}
          {step.state && <span className="text-xs text-slate-500">{step.state === "not_applicable" ? "Not applicable" : step.state === "inactive" ? "Not yet active" : "Awaiting update"}</span>}
          <span className="flex flex-wrap gap-x-3">
            <TaskMeta task={step.task} />
          </span>
          {step.completedAt && <span className="text-xs text-slate-400 sm:ml-auto">{formatLocalDate(step.completedAt)}</span>}
        </div>
      </div>
      {open && (
        <div className="ml-7 mt-1.5 space-y-2">
          {step.detail && <p className="text-xs text-slate-500">{step.detail}</p>}
          {step.trackingKey && canTrack && file && step.state !== "not_applicable" && (
            <button type="button" onClick={() => updateTracking()} disabled={busy} className="text-xs font-medium text-brand-primary disabled:opacity-50">
              {busy ? "Saving…" : step.completed ? "Reopen (staff)" : "Record completion (staff)"}
            </button>
          )}
          {step.trackingKey === "ownership" && canTrack && file && (
            <label className="flex items-center gap-2 text-xs text-slate-500">Responsible party
              <select aria-label="Ownership notice responsibility" value={step.responsible} disabled={busy}
                onChange={e => updateTracking(step.completed, e.target.value as "Client" | "iClosed")}
                className="rounded border border-slate-200 bg-white px-2 py-1">
                <option value="iClosed">iClosed</option><option value="Client">Client</option>
              </select>
            </label>
          )}
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        <ul className="space-y-1">
          {subTasks.map((t) => (
            <li key={t.key} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5">
                <StepIcon done={t.completed} size={14} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
                <span className={t.completed ? "text-slate-500" : "text-slate-800"}>{t.title}</span>
                <span className="flex flex-wrap gap-x-3">
                  <TaskMeta task={t} />
                </span>
                {t.completedAt && <span className="text-xs text-slate-400 sm:ml-auto">{formatLocalDate(t.completedAt)}</span>}
              </div>
            </li>
          ))}
        </ul>
        </div>
      )}
    </li>
  );
}

/** Request -> Requested (resend / cancel) -> Open client login, on the file's name row. */
function PermissionActions({ file }: { file: PortalFile }) {
  const ctx = useContext(TaskContext);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!ctx || isLocked(file)) return null;
  const { status, grantedAt, requestedAt, requestedTo, declinedAt } = file.permission;

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const act = (action: "request" | "withdraw") =>
    run(action, async () => {
      if (action === "withdraw" && !window.confirm("Cancel the request sent to the client?")) return;
      const res = await fetch(`/api/admin/agent-portal/${ctx.partnerId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leadId: file.rootLeadId, action }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      ctx.reload();
    });

  // Same as "Log into client view" in All Files: a magic link into the client's portal, in a new tab.
  const openPortal = () =>
    run("login", async () => {
      const res = await fetch(`/api/admin/agent-portal/${ctx.partnerId}/files/${file.rootLeadId}/client-login`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success || !data.url) throw new Error(data.error || `HTTP ${res.status}`);
      window.open(data.url, "_blank", "noopener,noreferrer");
    });

  const declined = status === "none" && declinedAt && (!requestedAt || declinedAt >= requestedAt);
  const spin = (key: string, icon: React.ReactNode) => (busy === key ? <Loader2 className="animate-spin" size={12} /> : icon);
  const outline =
    "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-brand-primary hover:border-brand-primary/40 hover:bg-red-50 disabled:opacity-50";
  const iconButton = "inline-flex h-full items-center px-2 text-brand-primary hover:bg-red-50 disabled:opacity-50";

  return (
    <span className="inline-flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      {status === "granted" && (
        <button
          type="button"
          onClick={openPortal}
          disabled={!!busy}
          title={`The client lets you complete tasks for them${grantedAt ? ` since ${formatLocalDate(grantedAt)}` : ""}. Opens their portal in a new tab.`}
          className={outline}
        >
          {spin("login", <LogIn size={12} />)}
          Open client login
        </button>
      )}
      {status === "requested" && (
        // One control: the state, plus resend and cancel as icons.
        <span className="inline-flex h-7 items-center divide-x divide-slate-200 overflow-hidden rounded-md border border-slate-200 bg-white text-xs font-semibold text-brand-primary">
          <span
            className="inline-flex h-full items-center gap-1.5 px-2.5"
            title={`Requested${requestedAt ? ` on ${formatLocalDate(requestedAt)}` : ""}${requestedTo ? ` from ${requestedTo}` : ""}. Waiting for the client to accept.`}
          >
            <Mail size={12} />
            Requested
          </span>
          <button type="button" onClick={() => act("request")} disabled={!!busy} title="Resend the request email" aria-label="Resend permission" className={iconButton}>
            {spin("request", <RotateCw size={12} />)}
          </button>
          <button type="button" onClick={() => act("withdraw")} disabled={!!busy} title="Cancel the request" aria-label="Cancel request" className={iconButton}>
            {spin("withdraw", <X size={12} />)}
          </button>
        </span>
      )}
      {status === "none" && (
        <button
          type="button"
          onClick={() => act("request")}
          disabled={!!busy}
          title={
            declined
              ? `The client declined on ${formatLocalDate(declinedAt)}. Ask again for permission to complete their tasks for them.`
              : "Ask the client for permission to complete their tasks for them."
          }
          className={outline}
        >
          {spin("request", <Lock size={12} />)}
          Request permission
        </button>
      )}
      {error && <span className="text-xs font-normal text-red-700">{error}</span>}
    </span>
  );
}

const OTHER_MAX_BYTES = maxUploadBytesForDocType("other");
const OTHER_ACCEPT = [...allowedUploadContentTypesForDocType("other"), ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].join(",");

/** A collapsible section styled like a stage row, for the file's Other documents and Notes. */
function ExtraRow({ title, summary, children }: { title: string; summary: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-slate-50" aria-expanded={open}>
        <span className="text-slate-400">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <span className="h-2 w-2 shrink-0 rounded-full bg-slate-300" />
        <span className="font-semibold text-slate-900">{title}</span>
        <span className="ml-auto font-mono text-xs text-slate-400">{summary}</span>
      </button>
      {open && <div className="mb-2 ml-6 md:ml-8">{children}</div>}
    </div>
  );
}

/** The agent's Other documents and private notes on a file; no client permission needed, as neither is the client's task. */
function FileExtras({ rootLeadId }: { rootLeadId: string }) {
  const ctx = useContext(TaskContext);
  const base = ctx ? `/api/admin/agent-portal/${ctx.partnerId}/files/${rootLeadId}` : "";
  const [docs, setDocs] = useState<AgentDocument[] | null>(null);
  const [note, setNote] = useState<AgentNote | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!base) return;
    (async () => {
      try {
        const res = await fetch(base);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        setDocs(data.documents);
        setNote(data.note);
        setDraft(data.note.note);
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
        setDocs([]);
      }
    })();
  }, [base]);

  if (!ctx) return null;

  const call = async (key: string, url: string, init: RequestInit) => {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.documents) setDocs(data.documents);
      if (data.note) {
        setNote(data.note);
        setDraft(data.note.note);
      }
      return true;
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const uploadFiles = async (list: FileList | null) => {
    const files = Array.from(list ?? []);
    if (input.current) input.current.value = "";
    if (files.length === 0) return;
    const failed: string[] = [];
    setMessage(null);
    setProgress({ done: 0, total: files.length });
    // One at a time, like the file page, so a failure names its file.
    for (const [i, f] of files.entries()) {
      try {
        if (f.size > OTHER_MAX_BYTES) throw new Error(`must be ${formatFileSize(OTHER_MAX_BYTES)} or smaller`);
        const blob = await upload(`${AGENT_UPLOAD_PREFIX}/${rootLeadId}/${Date.now()}-${f.name}`, f, {
          access: BLOB_ACCESS,
          handleUploadUrl: `${base}/documents/upload`,
          contentType: f.type,
        });
        const res = await fetch(`${base}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileUrl: blob.url, fileName: f.name, fileSize: f.size }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        setDocs(data.documents);
      } catch (err) {
        failed.push(`${f.name} (${err instanceof Error ? err.message : "failed"})`);
      }
      setProgress({ done: i + 1, total: files.length });
    }
    setProgress(null);
    setMessage(failed.length ? { ok: false, text: `Upload failed: ${failed.join(", ")}` } : { ok: true, text: `Uploaded ${files.length} document${files.length === 1 ? "" : "s"}.` });
  };

  const saveLabel = async (doc: AgentDocument) => {
    const value = editing?.value.trim() ?? "";
    setEditing(null);
    if (value !== (doc.label ?? "")) await call(`label-${doc.id}`, `${base}/documents`, { method: "PATCH", body: JSON.stringify({ docId: doc.id, label: value }) });
  };

  const noteDirty = !!note && draft.trim() !== note.note;

  return (
    <>
      <ExtraRow title="Other documents" summary={docs ? `${docs.length}` : ""}>
        <div className="flex flex-wrap items-center justify-between gap-2 py-2">
          <p className="text-xs text-slate-500">PDF, images or Office files up to {formatFileSize(OTHER_MAX_BYTES)}.</p>
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={!!progress}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-slate-700 hover:border-brand-primary hover:text-brand-primary disabled:opacity-50"
          >
            {progress ? <Loader2 className="animate-spin" size={12} /> : <Upload size={12} />}
            {progress ? `Uploading ${progress.done + 1} of ${progress.total}…` : "Upload"}
          </button>
          <input ref={input} type="file" multiple accept={OTHER_ACCEPT} onChange={(e) => uploadFiles(e.target.files)} className="hidden" />
        </div>
        {!docs ? (
          <p className="flex items-center gap-2 py-2 text-sm text-slate-500">
            <Loader2 className="animate-spin" size={14} /> Loading…
          </p>
        ) : docs.length === 0 ? (
          <p className="py-2 text-sm text-slate-500">No documents yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center gap-2.5 py-2 text-sm">
                <CheckCircle2 size={18} className="shrink-0 text-emerald-600" />
                <div className="min-w-0 flex-1">
                  {editing?.id === d.id ? (
                    <input
                      autoFocus
                      value={editing.value}
                      maxLength={120}
                      onChange={(e) => setEditing({ id: d.id, value: e.target.value })}
                      onBlur={() => saveLabel(d)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveLabel(d);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="h-7 w-full rounded-md border border-slate-200 px-2 text-sm focus:border-brand-primary focus:outline-none"
                    />
                  ) : (
                    <a href={docDownloadHref(d.fileUrl)} target="_blank" rel="noopener noreferrer" className="block truncate font-medium text-emerald-700 hover:underline">
                      {d.label || d.fileName || "Document"}
                    </a>
                  )}
                  <span className="block truncate text-xs text-slate-400">
                    {[d.label ? d.fileName : null, d.fileSize ? formatFileSize(d.fileSize) : null, d.createdAt ? formatLocalDate(d.createdAt) : null].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => call(`share-${d.id}`, `${base}/documents`, { method: "PATCH", body: JSON.stringify({ docId: d.id, shared: !d.shared }) })}
                  disabled={!!busy}
                  title={d.shared ? "The client can see this. Click to make it internal." : "Only our team can see this. Click to share it with the client."}
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold disabled:opacity-50 ${d.shared ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
                >
                  {d.shared ? "Shared" : "Internal"}
                </button>
                <button type="button" onClick={() => setEditing({ id: d.id, value: d.label || d.fileName || "" })} className="shrink-0 text-slate-400 hover:text-brand-primary" aria-label="Rename">
                  <PencilLine size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => window.confirm(`Remove ${d.label || d.fileName}?`) && call(`rm-${d.id}`, `${base}/documents?docId=${d.id}`, { method: "DELETE" })}
                  disabled={!!busy}
                  className="shrink-0 text-slate-400 hover:text-brand-primary disabled:opacity-50"
                  aria-label="Remove"
                >
                  {busy === `rm-${d.id}` ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </ExtraRow>

      <ExtraRow title="Notes" summary={note?.updatedAt ? `Saved ${formatLocalDate(note.updatedAt)}` : ""}>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          rows={4}
          disabled={!note || !note.schemaReady}
          placeholder={
            note && !note.schemaReady
              ? "Notes need migrations/2026-10-27-agent-file-notes.sql"
              : "Your own reminders for this file: follow up with the buyer's lender, key handover time, lockbox code, what the client asked you to check…"
          }
          className="mt-2 w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20 disabled:bg-slate-50"
        />
        {noteDirty && (
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setDraft(note?.note ?? "")} disabled={!!busy} className="h-8 rounded-md px-3 text-xs font-semibold text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => call("note", base, { method: "PUT", body: JSON.stringify({ note: draft }) })}
              disabled={!!busy}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-primary px-3 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy === "note" && <Loader2 className="animate-spin" size={12} />}
              Save note
            </button>
          </div>
        )}
      </ExtraRow>
      {message && <p className={`ml-8 text-sm md:ml-10 ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}
    </>
  );
}

function NotificationSettings({ partnerId }: { partnerId: string }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [schemaReady, setSchemaReady] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/admin/agent-portal/${partnerId}/notifications`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
        setTemplates(data.templates);
        setSchemaReady(data.schemaReady);
        setSelected(new Set(data.selected));
        setSaved(new Set(data.selected));
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
        setTemplates([]);
      }
    })();
  }, [partnerId]);

  // lead_type -> milestones, keeping the server's order.
  const groups = useMemo(() => {
    const out = new Map<string, Template[]>();
    for (const t of templates ?? []) out.set(t.lead_type, [...(out.get(t.lead_type) ?? []), t]);
    return out;
  }, [templates]);

  const toggle = (ids: string[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const dirty = selected.size !== saved.size || [...selected].some((id) => !saved.has(id));

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/agent-portal/${partnerId}/notifications`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stageTemplateIds: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setSaved(new Set(data.selected));
      setMessage({ ok: true, text: "Notification preferences saved." });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  };

  if (!templates) return <div className="flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={16} /> Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          Choose the milestones you want an email about when they are completed. This applies to all of your clients&apos; files.
        </p>
        <button
          onClick={save}
          disabled={!dirty || saving || !schemaReady}
          className="flex items-center justify-center gap-2 rounded-xl bg-brand-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
        >
          {saving ? <Loader2 className="animate-spin" size={16} /> : <Save size={16} />}
          Save preferences
        </button>
      </div>
      {message && (
        <div className={`px-4 py-3 rounded-xl text-sm border ${message.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-700"}`}>
          {message.text}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {[...groups].map(([leadType, list]) => {
          const ids = list.map((t) => t.id);
          const allOn = ids.every((id) => selected.has(id));
          return (
            <div key={leadType} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-900">{leadType}</h3>
                <button onClick={() => toggle(ids, !allOn)} className="text-xs font-semibold text-brand-primary hover:underline">
                  {allOn ? "Clear all" : "Select all"}
                </button>
              </div>
              <ul className="mt-3 space-y-1">
                {list.map((t) => (
                  <li key={t.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-800">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-sm"
                        checked={selected.has(t.id)}
                        onChange={(e) => toggle([t.id], e.target.checked)}
                      />
                      {t.name}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AgentPortal;
