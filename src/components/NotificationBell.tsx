"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, ChevronRight, Loader2 } from "lucide-react";

// The admin notification bell, mounted top-right in AppHeader.
//
// Two event types today, both raised server-side:
//   • `deal.all_tasks_complete` — src/lib/notifyAllTasksComplete.ts, once a
//     client AND their co-party finish every client-visible task on a file.
//   • `client.signed_up`        — src/lib/notifyClientSignup.ts, when a client
//     activates their portal account.
//
// The feed is a BROADCAST: every admin sees every row, and "read" is tracked
// per admin in notification_reads. Clicking a row marks it read and opens the
// deal it belongs to.
//
// Unread is shown as a plain red DOT, not a count. The bell sits in a light
// header where a number reads as clutter, and the useful signal is binary —
// "something is waiting". The exact count still shows inside the panel.

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

// Poll cadence for the unread dot. Task completion and signup are human-paced
// events, so a minute is plenty and keeps this cheap.
const POLL_MS = 60_000;

// How many rows the dropdown shows. The rest live on /admin/notifications.
const PANEL_LIMIT = 8;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const date = new Date(iso);
  const time = date.toLocaleTimeString("en-CA", {
    hour: "numeric",
    minute: "2-digit",
  });
  const days = Math.floor(hours / 24);
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) {
    return `${date.toLocaleDateString("en-CA", { weekday: "long" })}, ${time}`;
  }
  return date.toLocaleDateString("en-CA", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const NotificationBell: React.FC = () => {
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

  // The dot stays warm in the background; the panel refreshes on open. The
  // first fetch is deferred to a timeout rather than run inline, so mounting
  // the header doesn't set state synchronously inside the effect body.
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) load();
    };
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
    // Optimistic — the dot should clear the instant it's clicked.
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
      // Re-sync from the server so the dot doesn't lie if the write failed.
      load();
    }
  };

  const openNotification = async (n: Notification) => {
    setOpen(false);
    if (!n.read) await markRead({ ids: [n.id] });
    if (n.deal_id) router.push(`/admin/deals/${n.deal_id}`);
  };

  const visible = items.slice(0, PANEL_LIMIT);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={togglePanel}
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        className={`relative flex items-center justify-center w-10 h-10 rounded-xl border transition-colors ${
          open
            ? "border-slate-300 bg-slate-100 text-slate-900"
            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        }`}
      >
        <Bell size={20} />
        {unread > 0 && (
          // Binary signal only — the count lives in the panel header.
          <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-brand-primary ring-2 ring-white" />
        )}
      </button>

      {open && (
        <div
          className="fixed inset-x-3 top-16 sm:absolute sm:inset-x-auto sm:top-full sm:right-0 sm:mt-2 sm:w-[420px] z-50 max-h-[70vh] flex flex-col rounded-xl border border-slate-200 bg-white shadow-2xl text-slate-900"
          role="dialog"
          aria-label="Notifications"
        >
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
            <h2 className="text-base font-semibold">
              Notifications
              {unread > 0 && (
                <span className="ml-2 text-xs font-medium text-brand-primary align-middle">
                  {unread} new
                </span>
              )}
            </h2>
            {unread > 0 && (
              <button
                onClick={() => markRead({ all: true })}
                className="text-sm font-medium text-brand-primary hover:underline"
              >
                Mark all as read
              </button>
            )}
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
              <ul>
                {visible.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => openNotification(n)}
                      className={`w-full text-left px-5 py-3.5 flex items-start gap-3 transition-colors ${
                        n.read ? "hover:bg-slate-50" : "bg-brand-light/30 hover:bg-brand-light/50"
                      }`}
                    >
                      <span className="w-2.5 shrink-0 pt-1.5">
                        {!n.read && (
                          <span className="block w-2.5 h-2.5 rounded-full bg-brand-primary" />
                        )}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span
                          className={`block text-sm leading-snug ${
                            n.read ? "text-slate-600" : "font-medium text-slate-900"
                          }`}
                        >
                          {n.title}
                        </span>
                        <span className="block mt-1 text-xs text-slate-400">
                          {relativeTime(n.created_at)}
                        </span>
                      </span>
                      <ChevronRight size={16} className="shrink-0 mt-0.5 text-slate-300" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Link
            href="/admin/notifications"
            onClick={() => setOpen(false)}
            className="block px-5 py-3.5 text-center text-sm font-medium text-slate-600 border-t border-slate-100 hover:bg-slate-50 transition-colors"
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
