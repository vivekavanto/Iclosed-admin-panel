"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, FileText, Loader2, X } from "lucide-react";

/**
 * Progress for background blog imports (src/lib/blogImportQueue.ts).
 *
 * Everything shown here is read back from the database, so the admin can leave
 * the page, close the tab or come back later — the import keeps running on the
 * server and this panel picks up where it is. Polls only while something is
 * running. A finished import simply disappears — its drafts are in the list.
 */

type StepStatus = "pending" | "done" | "failed" | "skipped";

type Item = {
  id: string;
  post_id: string | null;
  idx: number;
  title: string;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  format_status: StepStatus;
  seo_status: StepStatus;
  image_status: StepStatus;
  needs_review: boolean;
  is_duplicate: boolean;
  warnings: string[];
  last_error: string | null;
};

type Batch = {
  id: string;
  created_at: string;
  file_name: string;
  status: "queued" | "extracting" | "processing" | "completed" | "failed" | "cancelled";
  publish_when_ready: boolean;
  total: number;
  published: number;
  error: string | null;
  items: Item[];
};

const POLL_MS = 3000;
const ACTIVE = new Set(["queued", "extracting", "processing"]);

const stepFinished = (s: StepStatus) => s !== "pending";

/** 0–100. Reading the document is the first 10%; the three steps per article share the rest. */
function progressOf(b: Batch): number {
  if (b.status === "queued") return 2;
  if (b.status === "extracting") return 6;
  if (b.items.length === 0) return b.status === "completed" || b.status === "failed" ? 100 : 10;
  let finished = 0;
  for (const i of b.items) {
    if (i.status === "failed" || i.status === "cancelled" || i.status === "done") {
      finished += 3;
      continue;
    }
    finished += [i.format_status, i.seo_status, i.image_status].filter(stepFinished).length;
  }
  return Math.round(10 + (90 * finished) / (3 * b.items.length));
}

function statusLine(b: Batch): string {
  const done = b.items.filter((i) => i.status === "done").length;
  const failed = b.items.filter((i) => i.status === "failed").length;
  switch (b.status) {
    case "queued":
      return "Waiting to start…";
    case "extracting":
      return "Reading the document and splitting it into articles…";
    case "processing":
      return (
        `Formatting, SEO and cover images — ${done} of ${b.items.length} articles ready` +
        (failed ? `, ${failed} failed` : "")
      );
    case "completed":
      return (
        `Done — ${done} of ${b.items.length} ready` +
        (b.published ? `, ${b.published} published` : "") +
        (failed ? `, ${failed} failed` : "")
      );
    case "cancelled":
      return `Cancelled — ${done} of ${b.items.length} were finished before it stopped.`;
    case "failed":
      return b.error ?? "The import failed.";
  }
}

function StepPill({ label, status, running }: { label: string; status: StepStatus; running: boolean }) {
  const cls =
    status === "done"
      ? "bg-green-100 text-green-700"
      : status === "failed"
      ? "bg-red-100 text-red-700"
      : status === "skipped"
      ? "bg-slate-100 text-slate-400"
      : "bg-slate-100 text-slate-500";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}
    >
      {status === "pending" && running && <Loader2 size={10} className="animate-spin" />}
      {label}
    </span>
  );
}

interface Props {
  /** Bump after queueing an upload so the panel starts polling straight away. */
  refreshKey: number;
  /** Called when drafts appear or an import finishes, so the posts table can reload. */
  onPostsChanged: () => void;
}

export default function BlogImportProgress({ refreshKey, onPostsChanged }: Props) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Signature of what the posts table depends on (article count + finished
  // articles per batch), so the table reloads only when that changes.
  const lastSignature = useRef<string>("");
  const onPostsChangedRef = useRef(onPostsChanged);
  useEffect(() => {
    onPostsChangedRef.current = onPostsChanged;
  }, [onPostsChanged]);

  const load = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch("/api/admin/blog/batches", { cache: "no-store" });
      const data = await res.json();
      if (!data?.success) return false;
      const next = (data.batches ?? []) as Batch[];
      setBatches(next);

      // Changes when a draft is created (post_id set) or an article finishes.
      const signature = next
        .map(
          (b) =>
            `${b.id}:${b.status}:${b.items.filter((i) => i.post_id).length}:${
              b.items.filter((i) => i.status === "done" || i.status === "failed").length
            }`
        )
        .join("|");
      if (lastSignature.current && signature !== lastSignature.current) onPostsChangedRef.current();
      lastSignature.current = signature;

      return next.some((b) => ACTIVE.has(b.status));
    } catch {
      return true; // a network blip — keep polling
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const active = await load();
      if (!cancelled && active) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load, refreshKey]);

  const act = async (batchId: string, action: "cancel" | "dismiss") => {
    if (action === "cancel" && !confirm("Stop this import? Drafts already created are kept.")) return;
    setBusy(batchId);
    try {
      await fetch(`/api/admin/blog/batches/${batchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      setBatches((prev) => prev.filter((b) => b.id !== batchId));
      if (action === "cancel") onPostsChangedRef.current();
    } finally {
      setBusy(null);
    }
  };

  if (batches.length === 0) return null;

  return (
    <div className="space-y-3">
      {batches.map((b) => {
        const active = ACTIVE.has(b.status);
        const pct = progressOf(b);
        const failedCount = b.items.filter((i) => i.status === "failed").length;
        const isOpen = expanded === b.id;
        const barColor =
          b.status === "failed"
            ? "bg-red-500"
            : b.status === "cancelled"
            ? "bg-slate-400"
            : b.status === "completed"
            ? failedCount > 0
              ? "bg-amber-500"
              : "bg-green-500"
            : "bg-brand-primary";

        return (
          <div key={b.id} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <div className="shrink-0">
                  {active ? (
                    <Loader2 size={18} className="animate-spin text-brand-primary" />
                  ) : b.status === "completed" && failedCount === 0 ? (
                    <CheckCircle2 size={18} className="text-green-600" />
                  ) : b.status === "cancelled" ? (
                    <X size={18} className="text-slate-400" />
                  ) : (
                    <AlertTriangle size={18} className="text-amber-600" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    Importing {b.file_name}
                    {b.publish_when_ready && (
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wide text-brand-primary">
                        auto-publish
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">{statusLine(b)}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {active ? (
                    <button
                      onClick={() => act(b.id, "cancel")}
                      disabled={busy === b.id}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={() => act(b.id, "dismiss")}
                      disabled={busy === b.id}
                      title="Hide"
                      className="p-1.5 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
                    >
                      <X size={14} />
                    </button>
                  )}
                  {b.items.length > 0 && (
                    <button
                      onClick={() => setExpanded(isOpen ? null : b.id)}
                      className="p-1.5 rounded-md text-slate-400 hover:bg-slate-100"
                      title={isOpen ? "Hide articles" : "Show articles"}
                    >
                      {isOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <div className="h-2 flex-1 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${barColor}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs font-semibold text-slate-600">{pct}%</span>
              </div>
              {active && (
                <p className="text-[11px] text-slate-400">
                  Runs on the server — you can leave this page. This bar disappears when it&apos;s done.
                </p>
              )}
            </div>

            {isOpen && (
              <ul className="border-t border-slate-100 divide-y divide-slate-100 bg-slate-50">
                {b.items.map((i) => {
                  const running = i.status === "processing";
                  return (
                    <li key={i.id} className="px-4 py-2.5 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileText size={14} className="text-slate-400 shrink-0" />
                        {i.post_id ? (
                          <Link
                            href={`/admin/blogs/${i.post_id}`}
                            className="text-sm font-medium text-slate-800 hover:text-brand-primary truncate max-w-md"
                          >
                            {i.title}
                          </Link>
                        ) : (
                          <span className="text-sm font-medium text-slate-800 truncate max-w-md">
                            {i.title}
                          </span>
                        )}
                        <StepPill label="Format" status={i.format_status} running={running} />
                        <StepPill label="SEO" status={i.seo_status} running={running} />
                        <StepPill label="Image" status={i.image_status} running={running} />
                        {i.status === "queued" && <span className="text-[11px] text-slate-400">queued</span>}
                        {i.status === "cancelled" && (
                          <span className="text-[11px] text-slate-400">cancelled</span>
                        )}
                        {i.needs_review && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                            {i.is_duplicate ? "Duplicate" : "Review"}
                          </span>
                        )}
                      </div>
                      {i.last_error && <p className="text-xs text-red-600 pl-6">{i.last_error}</p>}
                      {i.status !== "processing" && i.warnings.length > 0 && (
                        <ul className="pl-6 space-y-0.5">
                          {i.warnings.map((w, k) => (
                            <li key={k} className="text-xs text-amber-700">
                              • {w}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
