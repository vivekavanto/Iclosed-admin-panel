"use client";
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { ArrowLeft, Bell, CheckCircle2, Circle, ChevronDown, ChevronRight, Eye, Loader2, Save, Search, Upload } from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";
import { BLOB_ACCESS } from "@/lib/blobPrivacy";
import {
  daysBetween,
  type ClubbedTask,
  type PortalFile,
  type PortalSection,
  type PortalSide,
  type PortalStage,
  type PortalStep,
  type StageStatus,
  type UploadTarget,
  AGENT_UPLOAD_PREFIX,
} from "@/lib/agentPortal";

/** Lets a task row upload as the agent and refresh the dashboard afterwards. */
const UploadContext = createContext<{ partnerId: string; reload: () => void } | null>(null);

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
  const uploadContext = useMemo(() => ({ partnerId: partner.id, reload: () => setVersion((v) => v + 1) }), [partner.id]);

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
        // A reload after an upload keeps whatever the viewer has open.
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
    <UploadContext.Provider value={uploadContext}>
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
    </UploadContext.Provider>
  );
}

function SideBadge({ side, label }: { side: PortalSide; label: string }) {
  return <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${SIDE_BADGE[side]}`}>{label}</span>;
}

function StageBar({ stages }: { stages: PortalStage[] }) {
  return (
    <div className="grid grid-cols-3 gap-x-2 gap-y-3 md:grid-cols-6">
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
  const [docsOpen, setDocsOpen] = useState(false);
  const openDocs = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!open) onToggle();
    setDocsOpen((v) => !open || !v);
  };
  const pill = section.attention
    ? TONE.attention
    : file.status === "Closed"
      ? { pill: "bg-slate-100 text-slate-600", label: "Closed" }
      : file.status === "Cancelled"
        ? { pill: "bg-slate-100 text-slate-600", label: "Cancelled" }
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
                </div>
                <p className="mt-0.5 text-sm text-slate-500">
                  {file.fileNumber ?? "No file number"}
                  {section.address ? ` · ${section.address}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-sm md:flex-col md:items-end md:gap-1">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${pill.pill}`}>{pill.label}</span>
                <button
                  type="button"
                  onClick={openDocs}
                  onKeyDown={(e) => e.stopPropagation()}
                  aria-expanded={open && docsOpen}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-xs font-semibold text-brand-primary hover:bg-red-50"
                >
                  <Upload size={12} /> Upload documents
                </button>
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
          {docsOpen && <DocumentsPanel file={file} section={section} />}
          {section.stages.map((s) => (
            <StageRow key={s.id} stage={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function StageRow({ stage }: { stage: PortalStage }) {
  const [open, setOpen] = useState(stage.status !== "complete");
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
  return (
    <li className="py-2">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5">
          <StepIcon done={step.completed} size={18} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span className={`text-sm ${step.completed ? "text-slate-500" : "font-medium text-slate-900"}`}>{step.title}</span>
          <span className="flex flex-wrap gap-x-3">
            <TaskMeta task={step.task} />
          </span>
          {step.completedAt && <span className="text-xs text-slate-400 sm:ml-auto">{formatLocalDate(step.completedAt)}</span>}
        </div>
      </div>
      {subTasks.length > 0 && (
        <ul className="ml-7 mt-1.5 space-y-1">
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
      )}
    </li>
  );
}

/** One document the file still accepts: a task's file field for one client (or the whole file). */
type Slot = { id: string; taskId: string; leadId: string; client: string; task: string; field: string | null; fieldId: string; required: boolean; filled: boolean };

const OTHER = "other";

// "Upload Identification" -> "Identification"; the agent is already uploading.
const docName = (title: string) => title.trim().replace(/^(upload|provide)\s+(your\s+)?/i, "").replace(/^./, (c) => c.toUpperCase());

/** "Primary ID - Front" + "Primary ID - Back" -> "Primary ID (front & back)". */
function joinFields(fields: string[]) {
  const out: string[] = [];
  for (const f of fields) {
    const m = f.match(/^(.*?)\s*-\s*(front|back)$/i);
    const pair = m && fields.find((g) => g !== f && g.toLowerCase() === `${m[1]} - ${m[2].toLowerCase() === "front" ? "back" : "front"}`.toLowerCase());
    if (m && pair) {
      const both = `${m[1]} (front & back)`;
      if (!out.includes(both)) out.push(both);
    } else out.push(f);
  }
  return out.join(", ");
}

function slotsOf(section: PortalSection): Slot[] {
  const tasks = section.stages.flatMap((st) => st.steps.flatMap((s) => [s.task, ...s.subTasks])).filter((t): t is ClubbedTask => !!t);
  return tasks.flatMap((t) =>
    t.uploads.flatMap((u: UploadTarget) =>
      u.fields.map((f) => ({
        id: `${u.taskId}:${f.id}`,
        taskId: u.taskId,
        leadId: u.leadId,
        client: u.client,
        task: docName(t.title),
        // Only worth naming when the task asks for several files.
        field: u.fields.length > 1 && docName(f.label).toLowerCase() !== docName(t.title).toLowerCase() ? f.label.trim() : null,
        fieldId: f.id,
        required: f.required,
        filled: f.filled,
      })),
    ),
  );
}

const slotLabel = (s: Slot) => `${s.field ? `${s.task} – ${s.field}` : s.task}${s.client ? ` (${s.client})` : ""}`;

/** The one place an agent uploads documents for a file, one at a time. */
function DocumentsPanel({ file, section }: { file: PortalFile; section: PortalSection }) {
  const ctx = useContext(UploadContext);
  const slots = useMemo(() => slotsOf(section), [section]);
  const [choice, setChoice] = useState("");
  const [label, setLabel] = useState("");
  const [picked, setPicked] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  if (!ctx) return null;

  // One line per missing document (per client for personal ones), with the parts still missing.
  const pending = new Map<string, { doc: string; client: string; parts: string[] }>();
  for (const s of slots) {
    if (!s.required || s.filled) continue;
    const key = `${s.task}|${s.client}`;
    const line = pending.get(key) ?? { doc: s.task, client: s.client, parts: [] };
    if (s.field) line.parts.push(s.field);
    pending.set(key, line);
  }

  const submit = async () => {
    const slot = slots.find((s) => s.id === choice);
    if (!picked || (!slot && choice !== OTHER)) return;
    setBusy(true);
    setMessage(null);
    try {
      const owner = slot ? slot.leadId : file.rootLeadId;
      const blob = await upload(`${AGENT_UPLOAD_PREFIX}/${owner}/${Date.now()}-${picked.name}`, picked, {
        access: BLOB_ACCESS,
        handleUploadUrl: `/api/admin/agent-portal/${ctx.partnerId}/upload/token`,
        clientPayload: JSON.stringify(slot ? { taskId: slot.taskId } : { leadId: file.rootLeadId }),
        contentType: picked.type,
      });
      const res = await fetch(`/api/admin/agent-portal/${ctx.partnerId}/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          slot
            ? { taskId: slot.taskId, fieldId: slot.fieldId, fileUrl: blob.url, fileName: picked.name }
            : { leadId: file.rootLeadId, label, fileUrl: blob.url, fileName: picked.name },
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`);
      setMessage({ ok: true, text: `${picked.name} uploaded${data.taskCompleted ? " and the task is complete" : ""}.` });
      setPicked(null);
      setChoice("");
      setLabel("");
      if (input.current) input.current.value = "";
      ctx.reload();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const control = "h-8 rounded-md border border-slate-200 bg-white px-2 text-sm focus:border-brand-primary focus:outline-none";
  return (
    <div className="mx-2 mb-3 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 md:mx-0">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
          className="min-w-0 text-sm text-slate-700 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-slate-200 file:bg-white file:px-3 file:text-sm file:font-medium file:text-slate-700"
        />
        <select value={choice} onChange={(e) => setChoice(e.target.value)} className={`${control} min-w-0 lg:flex-1`} aria-label="What is this document?">
          <option value="">What is it?</option>
          {slots.map((s) => (
            <option key={s.id} value={s.id}>
              {slotLabel(s)}
              {s.filled ? " – uploaded" : !s.required ? " – optional" : ""}
            </option>
          ))}
          <option value={OTHER}>Other document</option>
        </select>
        {choice === OTHER && (
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder="Describe it (optional)" className={`${control} lg:w-56`} />
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!picked || !choice || busy}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-brand-primary px-3 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
          Upload
        </button>
      </div>
      <p className="text-xs text-slate-500">PDF, JPG or PNG, up to 10 MB, uploaded on the client&apos;s behalf. Other documents go to our team only.</p>
      {message && <p className={`text-sm ${message.ok ? "text-emerald-700" : "text-red-700"}`}>{message.text}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Pending documents</p>
          {pending.size === 0 ? (
            <p className="mt-1 text-sm text-slate-500">Nothing outstanding.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {[...pending.values()].map((l) => (
                <li key={`${l.doc}|${l.client}`} className="flex items-start gap-2 text-sm">
                  <Circle size={12} className="mt-1 shrink-0 text-slate-300" />
                  <span className="min-w-0">
                    <span className="text-slate-800">{l.doc}</span>
                    {l.client && <span className="text-slate-500"> · {l.client}</span>}
                    {l.parts.length > 0 && <span className="block text-xs text-slate-500">{joinFields(l.parts)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Uploaded by you</p>
          {file.agentUploads.length === 0 ? (
            <p className="mt-1 text-sm text-slate-500">No uploads yet.</p>
          ) : (
            <ul className="mt-1 space-y-1.5 text-sm">
              {file.agentUploads.map((u, i) => (
                <li key={i} className="flex items-start gap-2">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                  <span className="min-w-0 flex-1 break-words">
                    <span className="text-slate-800">{u.fileName}</span>
                    <span className="text-slate-500"> — {u.label}</span>
                  </span>
                  {u.uploadedAt && <span className="shrink-0 text-xs text-slate-400">{formatLocalDate(u.uploadedAt)}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
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
