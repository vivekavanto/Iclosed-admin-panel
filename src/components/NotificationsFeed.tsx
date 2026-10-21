"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, ChevronRight, Loader2, UserPlus, ListChecks, UserRoundPlus, MessageSquare } from "lucide-react";
import {
  CLIENT_MESSAGE_TYPE,
  CLIENT_SIGNUP_TYPE,
  ALL_TASKS_COMPLETE_TYPE,
  NEW_LEAD_TYPE,
  notificationHref,
  type NotificationRow,
} from "@/lib/notificationTypes";

// The full notification feed at /admin/notifications — the "View all
// notifications" destination from the header bell.
//
// Same broadcast data as the dropdown, just more of it and grouped by day. The
// dropdown deliberately stays short (8 rows); this is where an admin comes to
// catch up on a backlog or find something they dismissed.

const PAGE_LIMIT = 200;

/** Group key: "Today" / "Yesterday" / "August 3, 2026". */
function dayLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(date)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString("en-CA", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

function iconFor(type: string) {
  if (type === CLIENT_SIGNUP_TYPE) return <UserPlus size={16} />;
  if (type === NEW_LEAD_TYPE) return <UserRoundPlus size={16} />;
  if (type === ALL_TASKS_COMPLETE_TYPE) return <ListChecks size={16} />;
  if (type === CLIENT_MESSAGE_TYPE) return <MessageSquare size={16} />;
  return <Bell size={16} />;
}

const NotificationsFeed: React.FC = () => {
  const router = useRouter();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/notifications?limit=${PAGE_LIMIT}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Failed to load notifications.");
        return;
      }
      setError("");
      setItems(data.data as NotificationRow[]);
      setUnread(data.unread_count as number);
    } catch {
      setError("Failed to load notifications.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const markRead = async (payload: { all: true } | { ids: string[] }) => {
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
      load();
    }
  };

  const openNotification = async (n: NotificationRow) => {
    if (!n.read) await markRead({ ids: [n.id] });
    const href = notificationHref(n);
    if (href) router.push(href);
  };

  // Preserves the server's newest-first order: rows are already sorted, so the
  // first time a day is seen is the right place for its heading.
  const groups: Array<{ label: string; rows: NotificationRow[] }> = [];
  for (const n of items) {
    const label = dayLabel(n.created_at);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.rows.push(n);
    else groups.push({ label, rows: [n] });
  }

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between px-6 py-5 border-b border-slate-100">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Notifications</h1>
          {unread > 0 && (
            <span className="text-sm font-medium text-brand-primary">{unread} unread</span>
          )}
        </div>
        {unread > 0 && (
          <button
            onClick={() => markRead({ all: true })}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium text-brand-primary hover:bg-brand-light/50 transition-colors"
          >
            <CheckCheck size={16} />
            Mark all as read
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 size={16} className="animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <p className="px-6 py-16 text-center text-sm text-red-600">{error}</p>
      ) : items.length === 0 ? (
        <div className="px-6 py-16 text-center">
          <Bell size={28} className="mx-auto text-slate-300" />
          <p className="mt-3 text-sm text-slate-500">You&apos;re all caught up.</p>
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.label}>
            <h2 className="px-6 py-2 text-xs font-semibold uppercase tracking-wide text-slate-400 bg-slate-50 border-y border-slate-100">
              {group.label}
            </h2>
            <ul>
              {group.rows.map((n) => (
                <li key={n.id}>
                  <button
                    onClick={() => openNotification(n)}
                    className={`w-full text-left px-6 py-4 flex items-start gap-4 border-b border-slate-50 transition-colors ${
                      n.read ? "hover:bg-slate-50" : "bg-brand-light/30 hover:bg-brand-light/50"
                    }`}
                  >
                    <span
                      className={`shrink-0 mt-0.5 flex items-center justify-center w-8 h-8 rounded-lg ${
                        n.read ? "bg-slate-100 text-slate-400" : "bg-brand-light text-brand-primary"
                      }`}
                    >
                      {iconFor(n.type)}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span
                        className={`block text-sm leading-snug ${
                          n.read ? "text-slate-600" : "font-medium text-slate-900"
                        }`}
                      >
                        {n.title}
                      </span>
                      {n.body && (
                        <span className="block mt-1 text-xs text-slate-500">{n.body}</span>
                      )}
                      <span className="block mt-1 text-xs text-slate-400">
                        {n.file_number ? `File ${n.file_number} · ` : ""}
                        {timeLabel(n.created_at)}
                      </span>
                    </span>
                    {!n.read && (
                      <span className="shrink-0 mt-2 w-2.5 h-2.5 rounded-full bg-brand-primary" />
                    )}
                    <ChevronRight size={16} className="shrink-0 mt-1.5 text-slate-300" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
};

export default NotificationsFeed;
