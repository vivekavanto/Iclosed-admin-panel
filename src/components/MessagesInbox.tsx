"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  Lock,
  Loader2,
  Mail,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  UserPlus,
  Zap,
} from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";

// Staff inbox for client chats (design: "Agent inbox"). One conversation per
// file. Left: conversations with filters. Centre: the thread with Reply /
// Private note. Right: who the client is. Replies are emailed to the client,
// who can answer by email or in the chat widget in their portal.

type Row = {
  id: string;
  name: string;
  co_count: number;
  file_number: string | null;
  status: "open" | "resolved";
  assignee_email: string | null;
  assignee_name: string | null;
  preview: string;
  last_at: string;
  unread: number;
  channel: "portal" | "email";
};

type Msg = {
  id: string;
  kind: "message" | "note" | "event";
  sender_type: "admin" | "client" | "system";
  sender_name: string | null;
  body: string;
  source: "portal" | "email";
  created_at: string;
  read_by_client_at: string | null;
};

type Detail = {
  messages: Msg[];
  conversation: { status: "open" | "resolved"; assignee_email: string | null; assignee_name: string | null; rating: number | null; rating_comment: string | null } | null;
  people: { name: string; email: string | null; phone: string | null; primary: boolean }[];
  file: { deal_id: string; file_number: string | null; type: string | null; status: string | null; property_address: string | null; closing_date: string | null } | null;
  other_files: { id: string; file_number: string | null; property_address: string | null }[];
  staff: { name: string; email: string }[];
};

type Filter = "open" | "mine" | "unassigned" | "resolved";

const SAVED_REPLIES = [
  { key: "/hi", title: "Greeting", text: "Hi {name}, thanks for reaching out! Give me a moment to look into this." },
  { key: "/docs", title: "Documents reminder", text: "Could you please upload the outstanding documents in your portal under Your Documents? Let me know if anything is unclear." },
  { key: "/tasks", title: "Pending tasks", text: "A quick reminder to complete your pending tasks in the portal so we can keep your file moving." },
  { key: "/closing", title: "Closing date", text: "Your closing date is on track. I’ll let you know as soon as anything changes." },
  { key: "/handoff", title: "Hand off", text: "I’m looping in a colleague who will reply right here in this chat." },
  { key: "/bye", title: "Close out", text: "Glad I could help! I’ll mark this as resolved. Just reply here if anything else comes up." },
];

const TINTS = [
  "bg-rose-100 text-rose-800",
  "bg-sky-100 text-sky-800",
  "bg-emerald-100 text-emerald-800",
  "bg-violet-100 text-violet-800",
  "bg-amber-100 text-amber-800",
  "bg-teal-100 text-teal-800",
];

function tint(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function relTime(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  if (h < 48) return "Yesterday";
  return d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString("en-CA", { month: "long", day: "numeric", year: "numeric" });
}

const LIST_POLL = 10_000;
const THREAD_POLL = 6_000;

const MessagesInbox: React.FC<{ initialId?: string | null }> = ({ initialId = null }) => {
  const { user } = useAuth();
  const myEmail = (user?.email ?? "").toLowerCase();

  const [rows, setRows] = useState<Row[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [activeId, setActiveId] = useState<string | null>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);

  const flash = (text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 4000);
  };

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/messages", { cache: "no-store" });
      const json = await res.json();
      if (json.success) setRows(json.data as Row[]);
    } catch {
      /* keep what we have */
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string, quiet = false) => {
    if (!quiet) setDetailLoading(true);
    try {
      const res = await fetch(`/api/admin/messages/${id}`, { cache: "no-store" });
      const json = await res.json();
      if (json.success) setDetail(json.data as Detail);
    } catch {
      /* keep what we have */
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
    const t = setInterval(() => document.visibilityState === "visible" && void loadList(), LIST_POLL);
    return () => clearInterval(t);
  }, [loadList]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    seenCount.current = 0;
    setDetail(null);
    void loadDetail(activeId);
    const t = setInterval(() => document.visibilityState === "visible" && void loadDetail(activeId, true), THREAD_POLL);
    return () => clearInterval(t);
  }, [activeId, loadDetail]);

  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== seenCount.current) {
      seenCount.current = n;
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [detail]);

  const mine = useCallback((r: Row) => !!myEmail && (r.assignee_email ?? "").toLowerCase() === myEmail, [myEmail]);

  const counts = useMemo(
    () => ({
      open: rows.filter((r) => r.status === "open").length,
      mine: rows.filter((r) => r.status === "open" && mine(r)).length,
      unassigned: rows.filter((r) => r.status === "open" && !r.assignee_email).length,
      resolved: rows.filter((r) => r.status === "resolved").length,
    }),
    [rows, mine],
  );

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "resolved" ? r.status !== "resolved" : r.status !== "open") return false;
      if (filter === "mine" && !mine(r)) return false;
      if (filter === "unassigned" && r.assignee_email) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q) || (r.file_number ?? "").toLowerCase().includes(q);
    });
  }, [rows, filter, search, mine]);

  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  const people = detail?.people ?? [];
  const title = activeRow?.name ?? people[0]?.name ?? "Conversation";
  const status = detail?.conversation?.status ?? activeRow?.status ?? "open";
  const assigneeName = detail?.conversation?.assignee_name ?? activeRow?.assignee_name ?? null;
  const assigneeEmail = detail?.conversation?.assignee_email ?? activeRow?.assignee_email ?? null;

  const pick = (id: string) => {
    setActiveId(id);
    setAssignOpen(false);
    setMode("reply");
    setDraft("");
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, unread: 0 } : r)));
  };

  const shortcutMatches = useMemo(() => {
    if (mode !== "reply" || !draft.startsWith("/") || draft.includes(" ")) return [];
    const q = draft.slice(1).toLowerCase();
    return SAVED_REPLIES.filter((k) => k.key.slice(1).startsWith(q) || k.title.toLowerCase().includes(q));
  }, [draft, mode]);

  const firstName = (people[0]?.name ?? "").split(" ")[0] || "there";
  const insertSaved = (k: (typeof SAVED_REPLIES)[number]) => setDraft(k.text.replace("{name}", firstName));

  const send = async () => {
    const body = draft.trim();
    if (!body || sending || !activeId) return;
    setSending(true);
    try {
      const res = await fetch(`/api/admin/messages/${activeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, kind: mode === "note" ? "note" : "message" }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not send");
      setDraft("");
      if (mode === "reply") {
        flash(json.emailError ? `Saved to the chat, but the email failed: ${json.emailError}` : "Sent — the client was emailed", !!json.emailError);
      }
      await Promise.all([loadDetail(activeId, true), loadList()]);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not send", true);
    } finally {
      setSending(false);
    }
  };

  const patch = async (payload: Record<string, unknown>) => {
    if (!activeId) return;
    try {
      const res = await fetch(`/api/admin/messages/${activeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not update");
      await Promise.all([loadDetail(activeId, true), loadList()]);
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not update", true);
    }
  };

  const filters: { id: Filter; label: string }[] = [
    { id: "open", label: "Open" },
    { id: "mine", label: "Mine" },
    { id: "unassigned", label: "Unassigned" },
    { id: "resolved", label: "Resolved" },
  ];

  let lastDay = "";
  const lastAdminId = [...(detail?.messages ?? [])].reverse().find((m) => m.sender_type === "admin" && m.kind === "message")?.id;

  return (
    <div className="relative flex h-[calc(100vh-9.5rem)] min-h-[560px] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      {/* ── Conversations ── */}
      <section
        aria-label="Conversations"
        className={`${activeId ? "hidden lg:flex" : "flex"} w-full lg:w-80 xl:w-[340px] flex-none flex-col border-r border-slate-200`}
      >
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h1 className="text-lg font-bold text-slate-900">Inbox</h1>
            <span className="text-xs text-slate-500">{counts.open} open</span>
          </div>
          <div className="relative">
            <label htmlFor="conv-search" className="sr-only">Search conversations</label>
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              id="conv-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search names, files or messages"
              className="h-9 w-full rounded-lg border border-slate-300 bg-slate-50 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
            />
          </div>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-slate-100 p-1">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={`flex h-8 items-center justify-center gap-1 rounded-md px-1 text-[12.5px] font-medium transition-all ${
                  filter === f.id ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                {f.label}
                {counts[f.id] > 0 && (
                  <span className={`rounded-full px-1.5 text-[10.5px] font-semibold leading-4 ${filter === f.id ? "bg-brand-primary text-white" : "bg-slate-200 text-slate-600"}`}>
                    {counts[f.id]}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {listLoading ? (
            <div className="flex justify-center py-10 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>
          ) : visible.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-slate-500">
              <p className="font-semibold text-slate-800">Nothing here</p>
              <p>No conversations match this filter.</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {visible.map((r) => {
                const current = r.id === activeId;
                return (
                  <li key={r.id}>
                    <button
                      onClick={() => pick(r.id)}
                      aria-current={current}
                      className={`relative flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-primary/40 ${
                        current ? "bg-slate-100" : "hover:bg-slate-50"
                      }`}
                    >
                      {current && <span aria-hidden className="absolute inset-y-2 left-0 w-1 rounded-full bg-brand-primary" />}
                      <span className={`flex h-10 w-10 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${tint(r.name)}`}>
                        {initials(r.name)}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm ${r.unread ? "font-bold" : "font-semibold"} text-slate-900`}>
                            {r.name}
                            {r.co_count > 0 && <span className="font-normal text-slate-400"> +{r.co_count}</span>}
                          </span>
                          <span className={`flex-none text-[11.5px] ${r.unread ? "font-semibold text-brand-primary" : "text-slate-400"}`}>{relTime(r.last_at)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-[13px] ${r.unread ? "font-medium text-slate-900" : "text-slate-500"}`}>{r.preview}</span>
                          {r.unread > 0 && (
                            <span className="flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-brand-primary px-1.5 text-[11px] font-semibold text-white">
                              {r.unread}
                            </span>
                          )}
                        </span>
                        <span className="flex items-center gap-1.5 text-[11.5px] text-slate-500">
                          <span className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">
                            {r.channel === "email" ? <Mail size={11} /> : <MessageSquare size={11} />}
                            {r.channel === "email" ? "Email" : "Chat"}
                          </span>
                          {r.file_number && <span className="flex-none whitespace-nowrap">{r.file_number}</span>}
                          <span aria-hidden className="flex-none">·</span>
                          <span className={`truncate ${r.assignee_name ? "" : "italic text-slate-400"}`}>
                            {r.assignee_name ? (mine(r) ? "You" : r.assignee_name) : "Unassigned"}
                          </span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ── Thread ── */}
      <main className={`${activeId ? "flex" : "hidden lg:flex"} min-w-0 flex-1 flex-col`}>
        {!activeId ? (
          <div className="m-auto flex flex-col items-center gap-2 px-6 text-center text-slate-500">
            <MessageSquare size={32} className="text-slate-300" />
            <p className="font-semibold text-slate-800">Select a conversation</p>
            <p className="max-w-xs text-sm">Replies you send are emailed to the client, who can answer by email or in their portal chat.</p>
          </div>
        ) : (
          <>
            <header className="flex min-h-[68px] flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
              <button onClick={() => setActiveId(null)} aria-label="Back to conversations" className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden">
                <ArrowLeft size={18} />
              </button>
              <span className={`flex h-9 w-9 flex-none items-center justify-center rounded-full text-[13px] font-semibold ${tint(title)}`}>{initials(title)}</span>
              <div className="min-w-[140px] flex-1">
                <h2 className="truncate text-[15px] font-semibold text-slate-900">{title}</h2>
                <p className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span className={`h-2 w-2 rounded-full ${status === "open" ? "bg-emerald-500" : "bg-slate-300"}`} />
                  {status === "open" ? "Open" : "Resolved"}
                  {detail?.file?.file_number && (<><span aria-hidden>·</span>File {detail.file.file_number}</>)}
                </p>
              </div>

              <div className="relative">
                <button
                  onClick={() => setAssignOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={assignOpen}
                  className="flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  <UserPlus size={16} />
                  <span>{assigneeEmail ? (assigneeEmail.toLowerCase() === myEmail ? "You" : assigneeName) : "Assign"}</span>
                  <ChevronDown size={14} />
                </button>
                {assignOpen && (
                  <div role="menu" className="absolute right-0 top-11 z-20 w-60 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Assign to</p>
                    <button
                      role="menuitemradio"
                      aria-checked={!assigneeEmail}
                      onClick={() => { setAssignOpen(false); void patch({ action: "assign", email: null }); }}
                      className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="flex-1 text-slate-600">Unassigned</span>
                      {!assigneeEmail && <Check size={16} />}
                    </button>
                    {(detail?.staff ?? []).map((s) => {
                      const checked = (assigneeEmail ?? "").toLowerCase() === s.email.toLowerCase();
                      return (
                        <button
                          key={s.email}
                          role="menuitemradio"
                          aria-checked={checked}
                          onClick={() => { setAssignOpen(false); void patch({ action: "assign", email: s.email }); }}
                          className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-slate-50"
                        >
                          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold ${tint(s.name || s.email)}`}>{initials(s.name || s.email)}</span>
                          <span className="flex-1 truncate">{s.email.toLowerCase() === myEmail ? "You" : s.name || s.email}</span>
                          {checked && <Check size={16} />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              <button
                onClick={() => void patch({ action: status === "open" ? "resolve" : "reopen" })}
                className={`flex h-9 items-center gap-2 rounded-lg border px-3.5 text-[13px] font-semibold transition-colors ${
                  status === "open"
                    ? "border-emerald-600 bg-white text-emerald-700 hover:bg-emerald-50"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {status === "open" ? <CircleCheck size={16} /> : <RotateCcw size={16} />}
                {status === "open" ? "Resolve" : "Reopen"}
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto bg-gradient-to-b from-slate-50 to-slate-100/60">
              {detailLoading && !detail ? (
                <div className="flex justify-center py-10 text-slate-400"><Loader2 size={18} className="animate-spin" /></div>
              ) : (
                <div aria-live="polite" className="flex flex-col gap-3.5 px-4 py-5 sm:px-6">
                  {(detail?.messages.length ?? 0) === 0 && (
                    <p className="py-10 text-center text-sm text-slate-400">No messages yet. Write the first one below.</p>
                  )}
                  {detail?.messages.map((m) => {
                    const label = dayLabel(m.created_at);
                    const divider = label !== lastDay ? (lastDay = label) : null;
                    return (
                      <React.Fragment key={m.id}>
                        {divider && (
                          <div className="flex items-center gap-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                            <span className="h-px flex-1 bg-slate-200" />{divider}<span className="h-px flex-1 bg-slate-200" />
                          </div>
                        )}
                        {m.kind === "event" ? (
                          <div className="flex justify-center">
                            <span className="rounded-full bg-slate-200/70 px-3 py-1 text-xs text-slate-600">{m.body} · {clock(m.created_at)}</span>
                          </div>
                        ) : m.kind === "note" ? (
                          <div className="max-w-[78%] self-end rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5">
                            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                              <Lock size={12} /> Private note · {m.sender_name} · {clock(m.created_at)}
                            </p>
                            <p className="whitespace-pre-wrap break-words text-sm text-amber-950">{m.body}</p>
                          </div>
                        ) : m.sender_type === "client" ? (
                          <div className="flex max-w-[78%] items-end gap-2.5">
                            <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tint(m.sender_name || "c")}`}>{initials(m.sender_name || "C")}</span>
                            <div className="min-w-0">
                              <div className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-900 shadow-sm">{m.body}</div>
                              <p className="mt-1 flex items-center gap-1 pl-1 text-[11.5px] text-slate-500">
                                {m.sender_name} · {clock(m.created_at)}
                                {m.source === "email" && (<><span aria-hidden>·</span><Mail size={11} /> by email</>)}
                              </p>
                            </div>
                          </div>
                        ) : (
                          <div className="flex max-w-[78%] flex-col items-end self-end">
                            <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-brand-primary px-4 py-2.5 text-sm leading-relaxed text-white shadow-sm">{m.body}</div>
                            <p className="mt-1 pr-1 text-[11.5px] text-slate-500">
                              {m.sender_name} · {clock(m.created_at)}
                              {m.id === lastAdminId && (m.read_by_client_at ? " · Seen" : " · Delivered")}
                            </p>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {detail?.conversation?.rating && (
                    <div className="mx-auto max-w-sm rounded-xl border border-slate-200 bg-white px-4 py-3 text-center text-sm">
                      <p className="font-semibold text-slate-900">Client rating: {"★".repeat(detail.conversation.rating)}{"☆".repeat(5 - detail.conversation.rating)}</p>
                      {detail.conversation.rating_comment && <p className="mt-1 text-slate-600">“{detail.conversation.rating_comment}”</p>}
                    </div>
                  )}
                  <div ref={endRef} />
                </div>
              )}
            </div>

            <div className="relative border-t border-slate-100 bg-white px-4 pb-4 pt-3 sm:px-5">
              {shortcutMatches.length > 0 && (
                <div role="listbox" aria-label="Saved replies" className="absolute inset-x-4 bottom-[calc(100%-4px)] z-20 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl sm:inset-x-5">
                  <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Saved replies</span>
                    <span className="text-[11px] text-slate-500">Enter inserts the first match</span>
                  </div>
                  {shortcutMatches.map((k) => (
                    <button key={k.key} onClick={() => insertSaved(k)} className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left hover:bg-slate-50">
                      <span className="flex items-baseline gap-2"><span className="font-mono text-[12.5px] font-medium text-brand-primary">{k.key}</span><span className="text-[13.5px] font-medium text-slate-900">{k.title}</span></span>
                      <span className="max-w-full truncate text-xs text-slate-500">{k.text}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className={`rounded-xl border ${mode === "note" ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-white"} focus-within:ring-2 focus-within:ring-brand-primary/20`}>
                <div className="flex gap-0.5 px-1.5 pt-1.5">
                  <button onClick={() => setMode("reply")} aria-pressed={mode === "reply"} className={`h-[30px] rounded-md px-2.5 text-[13px] font-medium ${mode === "reply" ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}>Reply</button>
                  <button onClick={() => setMode("note")} aria-pressed={mode === "note"} className={`flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium ${mode === "note" ? "bg-amber-100 text-amber-900" : "text-slate-500 hover:bg-slate-50"}`}><Lock size={12} /> Private note</button>
                </div>
                <label htmlFor="composer" className="sr-only">{mode === "note" ? "Private note" : "Reply to the client"}</label>
                <textarea
                  id="composer"
                  rows={3}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value.slice(0, 5000))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (shortcutMatches.length > 0) insertSaved(shortcutMatches[0]);
                      else void send();
                    }
                  }}
                  placeholder={mode === "note" ? "Write a private note — only staff can see it" : "Reply to the client — they’ll be emailed. Type / for saved replies"}
                  className="block min-h-[76px] w-full resize-none rounded-b-xl bg-transparent px-3.5 py-2.5 text-sm text-slate-900 outline-none"
                />
                <div className="flex items-center gap-1 px-2 pb-2">
                  <button onClick={() => setDraft("/")} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-slate-600 hover:bg-slate-100">
                    <Zap size={15} /> Saved replies
                  </button>
                  <span className="flex-1" />
                  <span className="mr-2 hidden text-xs text-slate-500 sm:inline">Enter to send · Shift + Enter for a new line</span>
                  <button
                    onClick={() => void send()}
                    disabled={sending || !draft.trim()}
                    className="flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3.5 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-primaryHover disabled:opacity-50"
                  >
                    {mode === "note" ? "Add note" : "Send"}
                    {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ── Client details ── */}
      {activeId && (
        <aside aria-label="Client details" className="hidden w-80 flex-none flex-col overflow-y-auto border-l border-slate-200 bg-slate-50/50 xl:flex">
          <div className="flex flex-col items-center gap-2.5 border-b border-slate-200 bg-white px-5 pb-5 pt-7 text-center">
            <span className={`flex h-16 w-16 items-center justify-center rounded-full text-xl font-semibold ${tint(title)}`}>{initials(title)}</span>
            <div>
              <h2 className="text-base font-semibold text-slate-900">{title}</h2>
              {people[0]?.email && <p className="break-all text-[13px] text-slate-500">{people[0].email}</p>}
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status === "open" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
              {status === "open" ? "Open conversation" : "Resolved"}
            </span>
          </div>

          <section className="m-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">File</h3>
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
              {([
                ["File no.", detail?.file?.file_number],
                ["Type", detail?.file?.type],
                ["Status", detail?.file?.status],
                ["Property", detail?.file?.property_address],
                ["Closing", detail?.file?.closing_date ? new Date(detail.file.closing_date).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }) : null],
                ["Phone", people[0]?.phone],
              ] as [string, string | null | undefined][]).map(([k, v]) => (
                <React.Fragment key={k}>
                  <dt className="text-slate-500">{k}</dt>
                  <dd className="break-words text-slate-900">{v || "—"}</dd>
                </React.Fragment>
              ))}
            </dl>
            {detail?.file?.deal_id && (
              <Link href={`/admin/deals/${detail.file.deal_id}`} className="mt-3 inline-block text-[13px] font-semibold text-brand-primary hover:underline">
                Open file →
              </Link>
            )}
          </section>

          {people.length > 1 && (
            <section className="mx-3 mb-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
              <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">On this file</h3>
              <ul className="space-y-2">
                {people.map((p) => (
                  <li key={p.name + (p.email ?? "")} className="flex items-center gap-2.5 text-[13px]">
                    <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tint(p.name)}`}>{initials(p.name)}</span>
                    <span className="min-w-0"><span className="block truncate text-slate-900">{p.name}</span><span className="block truncate text-xs text-slate-500">{p.email}</span></span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mx-3 mb-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Other files</h3>
            {(detail?.other_files.length ?? 0) === 0 ? (
              <p className="text-[13px] text-slate-500">This is their only file.</p>
            ) : (
              <div className="space-y-2">
                {detail!.other_files.map((f) => (
                  <Link key={f.id} href={`/admin/deals/${f.id}`} className="flex justify-between gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 text-[13px] text-slate-900 hover:bg-slate-50">
                    <span className="truncate">{f.property_address || "File"}</span>
                    <span className="flex-none text-slate-500">{f.file_number}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </aside>
      )}

      {toast && (
        <div role="status" className={`absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg px-4 py-2 text-sm font-medium text-white shadow-lg ${toast.error ? "bg-red-600" : "bg-slate-900"}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
};

export default MessagesInbox;
