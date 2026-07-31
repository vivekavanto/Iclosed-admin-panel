"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Loader2, X } from "lucide-react";

// Sidebar bell for the in-app admin feed (/api/admin/notifications).
//
// Today the only event is `deal.all_tasks_complete` — raised by
// src/lib/notifyAllTasksComplete.ts once a client and their co-party have
// finished every client-visible task on a file. The feed is a broadcast: every
// admin sees every row, and "read" is tracked per admin.
//
// Rendered inside Sidebar's <nav>, so it inherits the dark rail styling. The
// dropdown itself is `fixed` and anchored past the rail using the --sidebar-w
// custom property that ClientLayout sets, so it stays put when the sidebar
// collapses.

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  deal_id: string | null;
  file_number: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read: boolean;
};

// Poll cadence for the unread badge. Task completion is a human-paced event, so
// a minute is plenty and keeps this cheap.
const POLL_MS = 60_000;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

interface NotificationBellProps {
  /** False when the desktop sidebar is collapsed — icon only, no label. */
  showLabel: boolean;
  /** Called after a navigation so the mobile drawer can close itself. */
  onNavigate?: () => void;
}

const NotificationBell: React.FC<NotificationBellProps> = ({ showLabel, onNavigate }) => {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/notifications");
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Failed to load notifications.");
        return;
      }
      setError("");
      setItems(data.data as Notification[]);
      setUnread(data.unread_count as number);
    } catch {
      // A transient blip shouldn't blank the panel — keep whatever we had.
      setError("Failed to load notifications.");
    }
  }, []);

  // Badge stays warm in the background; the panel refreshes on open. The first
  // fetch is deferred to a timeout rather than run inline, so mounting the
  // sidebar doesn't set state synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled) load(); };
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const togglePanel = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      await load();
      setLoading(false);
    }
  };

  const markRead = async (payload: { all: true } | { ids: string[] }) => {
    // Optimistic — the badge should drop the instant it's clicked.
    const targetIds = "all" in payload ? items.map((i) => i.id) : payload.ids;
    const targetSet = new Set(targetIds);
    setItems((prev) => prev.map((i) => (targetSet.has(i.id) ? { ...i, read: true } : i)));
    setUnread((prev) =>
      Math.max(0, prev - items.filter((i) => targetSet.has(i.id) && !i.read).length),
    );
    try {
      await fetch("/api/admin/notifications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // Re-sync from the server so the badge doesn't lie if the write failed.
      load();
    }
  };

  const openNotification = async (n: Notification) => {
    setOpen(false);
    if (!n.read) await markRead({ ids: [n.id] });
    if (n.deal_id) {
      router.push(`/admin/deals/${n.deal_id}`);
      onNavigate?.();
    }
  };

  return (
    <div ref={containerRef}>
      <button
        onClick={togglePanel}
        title={!showLabel ? "Notifications" : undefined}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 hover:bg-slate-800 hover:text-white ${
          showLabel ? "px-4 !justify-start gap-3" : ""
        } ${open ? "bg-slate-800 text-white" : ""}`}
      >
        <span className="relative flex shrink-0">
          <Bell size={20} />
          {unread > 0 && (
            <span
              className={`absolute -top-1.5 -right-2 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-primary text-white text-[10px] font-bold flex items-center justify-center ${
                showLabel ? "" : "ring-2 ring-slate-900"
              }`}
            >
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </span>
        {showLabel && <span className="font-medium text-sm">Notifications</span>}
      </button>

      {open && (
        <div
          className="fixed z-50 inset-x-3 top-16 md:inset-x-auto md:top-4 md:left-[var(--sidebar-w)] md:ml-3 md:w-[380px] max-h-[70vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-2xl text-slate-900"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <h2 className="text-sm font-semibold">
              Notifications
              {unread > 0 && (
                <span className="ml-2 text-xs font-medium text-brand-primary">{unread} new</span>
              )}
            </h2>
            <div className="flex items-center gap-1">
              {unread > 0 && (
                <button
                  onClick={() => markRead({ all: true })}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                  title="Mark all as read"
                >
                  <CheckCheck size={14} />
                  Mark all read
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                aria-label="Close notifications"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="overflow-y-auto">
            {loading && items.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
                <Loader2 size={16} className="animate-spin" />
                Loading…
              </div>
            ) : error && items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-red-600">{error}</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-slate-500">
                You&apos;re all caught up.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openNotification(n)}
                      className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${
                        n.read ? "" : "bg-brand-light/40"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        {!n.read && (
                          <span className="mt-1.5 w-2 h-2 rounded-full bg-brand-primary shrink-0" />
                        )}
                        <div className={`flex-1 min-w-0 ${n.read ? "pl-4" : ""}`}>
                          <p
                            className={`text-sm truncate ${
                              n.read ? "text-slate-600" : "font-semibold text-slate-900"
                            }`}
                          >
                            {n.title}
                          </p>
                          {n.body && (
                            <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">{n.body}</p>
                          )}
                          <p className="mt-1 text-[11px] text-slate-400">
                            {n.file_number ? `File ${n.file_number} · ` : ""}
                            {relativeTime(n.created_at)}
                          </p>
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
