"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bell, CheckCircle2, Circle, ChevronDown, ChevronRight, Eye, Loader2, Save, Search } from "lucide-react";
import { formatLocalDate } from "@/lib/formatDate";
import {
  STAGES,
  daysBetween,
  type ClubbedTask,
  type PortalFile,
  type PortalSection,
  type PortalSide,
  type PortalStage,
  type PortalStep,
  type StageStatus,
} from "@/lib/agentPortal";

type Partner = {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
};

type Template = { id: string; name: string; lead_type: string; milestone: string | null };

type View = "file" | "matrix" | "notifications";
type SideFilter = "all" | PortalSide;
type StatusFilter = "all" | "pending" | "completed";

/** One side of one file; a Purchase & Sale file gives two rows. */
type Row = { id: string; file: PortalFile; section: PortalSection };

const STORAGE_KEY = "agentPortal.partnerId";

const TONE: Record<StageStatus, { bar: string; text: string; cell: string; dot: string; pill: string; label: string }> = {
  complete: { bar: "bg-emerald-500", text: "text-slate-700", cell: "bg-emerald-50 text-emerald-800", dot: "bg-emerald-500", pill: "bg-emerald-50 text-emerald-700", label: "Complete" },
  attention: { bar: "bg-slate-500", text: "text-slate-700", cell: "bg-slate-100 text-slate-800", dot: "bg-slate-700", pill: "bg-slate-100 text-slate-700", label: "Needs attention" },
  progress: { bar: "bg-slate-500", text: "text-slate-700", cell: "bg-slate-100 text-slate-700", dot: "bg-slate-400", pill: "bg-slate-100 text-slate-600", label: "In progress" },
  not_started: { bar: "bg-slate-300", text: "text-slate-400", cell: "bg-slate-50 text-slate-400", dot: "bg-slate-300", pill: "bg-slate-50 text-slate-400", label: "Not started" },
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
  const [side, setSide] = useState<SideFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusId, setFocusId] = useState<string | null>(null);

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
        setExpanded(open);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [partner.id]);

  const rows = useMemo<Row[]>(() => (files ?? []).flatMap((file) => file.sections.map((section) => ({ id: `${file.rootLeadId}:${section.side}`, file, section }))), [files]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (side === "all" || r.section.side === side) &&
        (!q || [r.file.fileNumber, r.section.address, ...r.file.clients].some((v) => (v ?? "").toLowerCase().includes(q))),
    );
  }, [rows, search, side]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openFromMatrix = (id: string) => {
    setExpanded((prev) => new Set(prev).add(id));
    setFocusId(id);
    setView("file");
  };

  const stats = useMemo(() => {
    const all = files ?? [];
    const active = all.filter((f) => !isClosed(f));
    return [
      { label: "Files", value: all.length },
      { label: "Active", value: active.length },
      {
        label: "Closing in 30 days",
        value: active.filter((f) => f.closingDate && today && daysBetween(today, f.closingDate) >= 0 && daysBetween(today, f.closingDate) <= 30).length,
      },
      { label: "Needs attention", value: all.filter((f) => f.sections.some((s) => s.attention)).length },
      { label: "Pending tasks", value: all.flatMap((f) => f.sections).reduce((n, s) => n + s.pendingTasks, 0) },
    ];
  }, [files, today]);

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Agent portal</p>
          <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900 md:text-3xl">
            {partner.agent_name}
            {partner.brokerage_name && <span className="ml-2 text-lg font-normal text-slate-500 md:text-xl">{partner.brokerage_name}</span>}
          </h1>
        </div>
        <Segmented
          value={view}
          onChange={setView}
          tabs
          options={[
            { id: "file", label: "By file" },
            { id: "matrix", label: "Milestone matrix" },
            { id: "notifications", label: "Notifications", icon: <Bell size={14} /> },
          ]}
        />
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((s) => (
              <div key={s.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{s.label}</p>
                <p className="mt-1 text-2xl font-bold text-slate-900">{s.value}</p>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder="Search client, address or file number…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm shadow-sm focus:border-brand-primary focus:outline-none focus:ring-2 focus:ring-brand-primary/20"
              />
              <Search className="absolute left-3 top-3 text-slate-400" size={18} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Segmented value={side} onChange={setSide} options={[{ id: "all", label: "All" }, { id: "purchase", label: "Purchase" }, { id: "sale", label: "Sale" }]} />
              {view === "file" && (
                <Segmented value={status} onChange={setStatus} options={[{ id: "all", label: "All tasks" }, { id: "pending", label: "Pending" }, { id: "completed", label: "Completed" }]} />
              )}
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-500">
              {files.length === 0 ? "No referred files yet." : "No files match these filters."}
            </div>
          ) : view === "file" ? (
            <div className="space-y-3">
              {visible.map((r) => (
                <FileCard
                  key={r.id}
                  row={r}
                  status={status}
                  open={expanded.has(r.id)}
                  onToggle={() => toggle(r.id)}
                  focus={focusId === r.id}
                  onFocused={() => setFocusId(null)}
                />
              ))}
            </div>
          ) : (
            <Matrix rows={visible} onOpen={openFromMatrix} />
          )}
        </>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; icon?: React.ReactNode }[];
  tabs?: boolean;
}) {
  // Same looks as All Files: text tabs like its date presets, button groups like its Sort.
  if (tabs) {
    return (
      <div className="flex max-w-full items-center gap-5 overflow-x-auto">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(o.id)}
            className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium transition-colors ${
              value === o.id ? "text-brand-primary" : "text-slate-600 hover:text-brand-primary"
            }`}
          >
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center overflow-hidden rounded-md border border-slate-200 text-xs">
      {options.map((o, i) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-2.5 py-1 font-medium transition-colors ${i > 0 ? "border-l border-slate-200" : ""} ${
            value === o.id ? "bg-brand-primary text-white" : "bg-white text-slate-600 hover:text-brand-primary"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
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
  status,
  open,
  onToggle,
  focus,
  onFocused,
}: {
  row: Row;
  status: StatusFilter;
  open: boolean;
  onToggle: () => void;
  focus: boolean;
  onFocused: () => void;
}) {
  const { file, section } = row;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focus) return;
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    onFocused();
  }, [focus, onFocused]);

  const pill = section.attention
    ? TONE.attention
    : file.status === "Closed"
      ? { pill: "bg-slate-100 text-slate-600", label: "Closed" }
      : file.status === "Cancelled"
        ? { pill: "bg-slate-100 text-slate-600", label: "Cancelled" }
        : { pill: "bg-emerald-50 text-emerald-700", label: file.status ?? "Active" };

  return (
    <div ref={ref} className="scroll-mt-4 rounded-2xl border border-slate-200 bg-white shadow-sm">
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
          {section.stages.map((s) => (
            <StageRow key={`${s.id}:${status}`} stage={s} status={status} />
          ))}
        </div>
      )}
    </div>
  );
}

const keepStep = (s: PortalStep, status: StatusFilter) =>
  status === "all" || (status === "completed" ? s.completed || s.subTasks.some((t) => t.completed) : !s.completed || s.subTasks.some((t) => !t.completed));

function StageRow({ stage, status }: { stage: PortalStage; status: StatusFilter }) {
  const steps = stage.steps.filter((s) => keepStep(s, status));
  const [open, setOpen] = useState(status !== "all" || stage.status !== "complete");
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
            <StepRow key={s.key} step={s} status={status} />
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

function StepRow({ step, status }: { step: PortalStep; status: StatusFilter }) {
  const subTasks = step.subTasks.filter((t) => status === "all" || (status === "completed") === t.completed);
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

/** Outstanding work in a stage: open steps, plus open sub-tasks of finished ones. */
function outstanding(stage: PortalStage): string[] {
  return stage.steps.flatMap((s) => [...(s.completed ? [] : [s.title]), ...s.subTasks.filter((t) => !t.completed).map((t) => `${s.title}: ${t.title}`)]);
}

function MatrixCell({ stage, fill = "h-full" }: { stage: PortalStage | undefined; fill?: string }) {
  if (!stage) return <div className={`flex ${fill} min-h-14 items-center rounded-lg bg-slate-50/60 px-3 text-sm text-slate-300`}>—</div>;
  const tone = TONE[stage.status];
  const open = stage.steps.filter((s) => !s.completed);
  const missing = open.filter((s) => s.attention);
  const lead = (missing[0] ?? open[0])?.title;
  const extra = (missing.length || open.length) - 1;
  const tip = outstanding(stage);
  return (
    <div className={`flex ${fill} min-h-14 flex-col justify-center rounded-lg px-3 py-2 ${tone.cell}`} title={tip.length ? `Outstanding:\n• ${tip.join("\n• ")}` : "All done"}>
      {stage.status === "complete" ? (
        <span className="text-sm font-semibold">✓ Done</span>
      ) : (
        <>
          <span className="text-sm font-semibold">{stage.status === "attention" ? `${missing.length} missing` : `${stage.done} / ${stage.total}`}</span>
          {lead && (
            <span className="truncate text-xs opacity-80">
              {lead}
              {extra > 0 ? ` +${extra}` : ""}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function Overall({ section }: { section: PortalSection }) {
  const pct = section.total ? Math.round((section.done / section.total) * 100) : 0;
  return (
    <div className="w-full">
      <p className="text-right text-sm font-bold text-slate-900">{pct}%</p>
      <div className="mt-1 h-1.5 rounded-full bg-slate-200">
        <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Matrix({ rows, onOpen }: { rows: Row[]; onOpen: (id: string) => void }) {
  const fileLabel = (r: Row) => (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <SideBadge side={r.section.side} label={r.section.label} />
        <span className="truncate font-semibold text-slate-900">{r.file.clients.join(" & ") || "Unnamed client"}</span>
      </div>
      <p className="mt-0.5 truncate text-xs text-slate-500">
        {r.file.fileNumber}
        {r.section.address ? ` · ${r.section.address}` : ""}
      </p>
      {r.file.closingDate && (
        <p className="text-xs text-slate-500">
          Closing {formatLocalDate(r.file.closingDate)}
        </p>
      )}
    </>
  );
  const stageMap = (r: Row) => new Map(r.section.stages.map((s) => [s.id, s]));

  return (
    <div className="space-y-3">
      {/* Desktop: one row per file side, one column per stage. */}
      <div className="hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm md:block">
        <table className="w-full min-w-[900px] border-separate border-spacing-1.5 text-left">
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Client / file</th>
              {STAGES.map((s) => (
                <th key={s.id} className="px-3 py-2">
                  {s.short}
                </th>
              ))}
              <th className="px-3 py-2 text-right">Overall</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const map = stageMap(r);
              return (
                <tr key={r.id} onClick={() => !selecting() && onOpen(r.id)} className="cursor-pointer align-top hover:[&>td]:bg-slate-50/50">
                  <td className="w-64 max-w-64 rounded-lg px-3 py-2">{fileLabel(r)}</td>
                  {STAGES.map((s) => (
                    <td key={s.id} className="w-36 max-w-36 p-0">
                      <MatrixCell stage={map.get(s.id)} />
                    </td>
                  ))}
                  <td className="w-24 rounded-lg px-3 py-2 align-middle">
                    <Overall section={r.section} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: the same matrix as one card per file side. */}
      <div className="space-y-3 md:hidden">
        {rows.map((r) => {
          const map = stageMap(r);
          return (
            <div key={r.id} {...clickable(() => onOpen(r.id))} className="w-full cursor-pointer rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
              {fileLabel(r)}
              <div className="mt-3 grid grid-cols-2 gap-2">
                {STAGES.filter((s) => map.has(s.id)).map((s) => (
                  <div key={s.id} className="flex flex-col">
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">{s.short}</p>
                    <MatrixCell stage={map.get(s.id)} fill="flex-1" />
                  </div>
                ))}
              </div>
              <div className="mt-3">
                <Overall section={r.section} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-500">
        {(Object.keys(TONE) as StageStatus[]).map((k) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded border border-black/5 ${TONE[k].cell}`} />
            {TONE[k].label}
          </span>
        ))}
        <span>Hover a cell for outstanding tasks · click a row to open the file</span>
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

  // lead_type -> milestone -> templates, keeping the server's order.
  const groups = useMemo(() => {
    const out = new Map<string, Map<string, Template[]>>();
    for (const t of templates ?? []) {
      const byMs = out.get(t.lead_type) ?? new Map<string, Template[]>();
      const ms = t.milestone ?? "Other tasks";
      byMs.set(ms, [...(byMs.get(ms) ?? []), t]);
      out.set(t.lead_type, byMs);
    }
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
        body: JSON.stringify({ taskTemplateIds: [...selected] }),
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
          Choose the tasks you want an email about when they are completed. This applies to all of your clients&apos; files.
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
      {!schemaReady && (
        <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
          Settings can&apos;t be saved until <code>migrations/2026-10-22-partner-notification-settings.sql</code> is applied.
        </div>
      )}
      {message && (
        <div className={`px-4 py-3 rounded-xl text-sm border ${message.ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-red-50 border-red-200 text-red-700"}`}>
          {message.text}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {[...groups].map(([leadType, byMs]) => {
          const ids = [...byMs.values()].flat().map((t) => t.id);
          const allOn = ids.every((id) => selected.has(id));
          return (
            <div key={leadType} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-slate-900">{leadType}</h3>
                <button onClick={() => toggle(ids, !allOn)} className="text-xs font-semibold text-brand-primary hover:underline">
                  {allOn ? "Clear all" : "Select all"}
                </button>
              </div>
              <div className="mt-3 space-y-3">
                {[...byMs].map(([ms, list]) => (
                  <div key={ms}>
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{ms}</p>
                    <ul className="mt-1 space-y-1">
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
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AgentPortal;
