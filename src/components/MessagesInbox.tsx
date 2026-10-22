"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  FolderOpen,
  Lock,
  Loader2,
  Mail,
  MessageSquare,
  RotateCcw,
  Search,
  Send,
  UserPlus,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useAuth } from "@/lib/AuthProvider";
import { useChatChannel } from "@/hooks/useChatChannel";

// Staff inbox for client chats (design: "Agent inbox"). FILE-based: one
// conversation per file, shown by its file number and property — like an order
// whose courier can change. Staff only HANDLE a file's chat for a while
// ("Handled by"); whoever takes over sees the whole history, and the side panel
// lists everyone who has handled it. "Hand over files" moves all of one
// person's file chats to another (someone leaving). Replies are emailed to the
// client, who can answer by email or in the chat widget in their portal.
//
// Updates: polling, plus pings on the inbox channel
// that trigger an immediate refetch — then polling drops to a 60 s safety net.
// Pings also carry the client's typing and presence (online dot, "Last seen").

type Row = {
  id: string;
  name: string;
  co_count: number;
  file_number: string | null;
  property_address?: string | null;
  status: "open" | "resolved";
  assignee_email: string | null;
  assignee_name: string | null;
  preview: string;
  last_at: string;
  unread: number;
  channel: "portal" | "email";
  client_online?: boolean;
  client_last_seen_at?: string | null;
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
  handlers?: { name: string; email: string; started_at: string; ended_at: string | null }[];
};

/** "File 26S-0368" — the chat's title everywhere in the inbox. */
function fileTitle(fileNumber: string | null | undefined): string {
  return fileNumber ? `File ${fileNumber}` : "File (no number yet)";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

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

/** "Last seen 5 min ago" for the client's presence. */
function lastSeen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const m = Math.max(1, Math.round((Date.now() - t) / 60000));
  if (m < 60) return `Last seen ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last seen ${h} h ago`;
  return `Last seen ${new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}`;
}

const LIST_POLL = 10_000;
const THREAD_POLL = 6_000;
/** While realtime pings flow, polling is only a safety net. */
const LIVE_POLL = 60_000;
/** A typing indicator clears this long after the last ping (pings come every ~3 s). */
const TYPING_TTL = 6_000;
const TYPING_SEND_EVERY = 3_000;

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
  const assignRef = useRef<HTMLDivElement>(null);

  // Close the Assign menu on a click outside it, or on Escape.
  useEffect(() => {
    if (!assignOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!assignRef.current?.contains(e.target as Node)) setAssignOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAssignOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [assignOpen]);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const seenCount = useRef(0);
  const [inboxChannel, setInboxChannel] = useState<string | null>(null);
  // root -> { name, until }: the client on that file is typing.
  const [typing, setTyping] = useState<Record<string, { name: string; until: number }>>({});
  const [teamStatus, setTeamStatus] = useState<Record<string, "online" | "away" | "offline">>({});
  const lastTypingSent = useRef(0);
  const activeRef = useRef<string | null>(initialId);
  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const flash = (text: string, error = false) => {
    setToast({ text, error });
    setTimeout(() => setToast(null), 4000);
  };

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/messages", { cache: "no-store" });
      const json = await res.json();
      if (json.success) {
        setRows(json.data as Row[]);
        setInboxChannel(json.realtime?.inbox ?? null);
      }
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

  // Teammates' Online / Away, for the assign menu. Silent when presence is off
  // (and stops asking once the server says the migration hasn't run).
  const teamUnavailable = useRef(false);
  const loadTeam = useCallback(async () => {
    if (teamUnavailable.current) return;
    try {
      const res = await fetch("/api/admin/messages/presence", { cache: "no-store" });
      const json = await res.json();
      if (json.success && json.available === false) teamUnavailable.current = true;
      if (json.success && json.available) {
        const map: Record<string, "online" | "away" | "offline"> = {};
        for (const s of json.staff as { email: string; status: "online" | "away" | "offline" }[]) map[s.email.toLowerCase()] = s.status;
        setTeamStatus(map);
      }
    } catch {
      /* keep what we have */
    }
  }, []);

  // Realtime: a ping means "refetch". Bursts (message + read + assign) are
  // coalesced, and nothing is fetched for a hidden tab — opening the thread
  // marks the client's messages Seen, which must only happen when someone looks.
  const pending = useRef<{ list: boolean; detail: boolean; t: ReturnType<typeof setTimeout> | null }>({ list: false, detail: false, t: null });
  const refetchSoon = useCallback(
    (detailToo: boolean) => {
      const p = pending.current;
      p.list = true;
      p.detail = p.detail || detailToo;
      if (p.t) return;
      p.t = setTimeout(() => {
        const { list, detail: d } = p;
        p.list = p.detail = false;
        p.t = null;
        if (document.visibilityState !== "visible") return;
        if (list) void loadList();
        if (d && activeRef.current) void loadDetail(activeRef.current, true);
      }, 250);
    },
    [loadList, loadDetail],
  );
  const resync = useCallback(() => {
    void loadList();
    void loadTeam();
    if (activeRef.current) void loadDetail(activeRef.current, true);
  }, [loadList, loadDetail, loadTeam]);

  const { connected: live } = useChatChannel(
    inboxChannel,
    (event, payload) => {
      const root = typeof payload.root === "string" ? payload.root : "";
      if (event === "changed") {
        if (root) setTyping((t) => (t[root] ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== root)) : t));
        refetchSoon(!!root && root === activeRef.current);
      } else if (event === "presence") {
        refetchSoon(false);
      } else if (event === "typing" && root) {
        const name = typeof payload.name === "string" ? payload.name : "";
        setTyping((t) => ({ ...t, [root]: { name, until: Date.now() + TYPING_TTL } }));
      } else if (event === "staff") {
        void loadTeam();
      }
    },
    resync,
  );

  // Expire typing indicators.
  const typingCount = Object.keys(typing).length;
  useEffect(() => {
    if (typingCount === 0) return;
    const t = setInterval(() => {
      const now = Date.now();
      setTyping((cur) => {
        const kept = Object.entries(cur).filter(([, v]) => v.until > now);
        return kept.length === Object.keys(cur).length ? cur : Object.fromEntries(kept);
      });
    }, 1000);
    return () => clearInterval(t);
  }, [typingCount]);

  useEffect(() => {
    void loadList();
    const t = setInterval(() => document.visibilityState === "visible" && void loadList(), live ? LIVE_POLL : LIST_POLL);
    return () => clearInterval(t);
  }, [loadList, live]);

  useEffect(() => {
    void loadTeam();
    const t = setInterval(() => document.visibilityState === "visible" && void loadTeam(), LIVE_POLL);
    return () => clearInterval(t);
  }, [loadTeam]);

  useEffect(() => {
    if (!activeId) {
      setDetail(null);
      return;
    }
    seenCount.current = 0;
    setDetail(null);
    void loadDetail(activeId);
  }, [activeId, loadDetail]);

  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => document.visibilityState === "visible" && void loadDetail(activeId, true), live ? LIVE_POLL : THREAD_POLL);
    return () => clearInterval(t);
  }, [activeId, loadDetail, live]);

  // Staff typing a REPLY (never a private note) -> dots in the client's widget.
  const sendTyping = () => {
    if (!live || mode !== "reply" || !activeId) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SEND_EVERY) return;
    lastTypingSent.current = now;
    void fetch(`/api/admin/messages/${activeId}/typing`, { method: "POST" }).catch(() => {});
  };

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
      return (
        r.name.toLowerCase().includes(q) ||
        r.preview.toLowerCase().includes(q) ||
        (r.file_number ?? "").toLowerCase().includes(q) ||
        (r.property_address ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search, mine]);

  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  const people = detail?.people ?? [];
  // The CLIENTS on the file (avatars, saved-reply {name}); the FILE is the title.
  const title = activeRow?.name ?? people[0]?.name ?? "Client";
  const fileName = fileTitle(detail?.file?.file_number ?? activeRow?.file_number);
  const address = detail?.file?.property_address ?? activeRow?.property_address ?? null;
  const clientNames = people.length > 0 ? people.map((p) => p.name).join(", ") : title + (activeRow?.co_count ? ` +${activeRow.co_count}` : "");
  const status = detail?.conversation?.status ?? activeRow?.status ?? "open";
  const assigneeName = detail?.conversation?.assignee_name ?? activeRow?.assignee_name ?? null;
  const assigneeEmail = detail?.conversation?.assignee_email ?? activeRow?.assignee_email ?? null;
  const clientPresence = activeRow?.client_online ? "Online" : lastSeen(activeRow?.client_last_seen_at);
  const activeTyping = activeId ? typing[activeId] : undefined;

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

  // "Hand over files": move every file chat one person handles to another.
  const [handover, setHandover] = useState<null | {
    staff: { name: string; email: string }[];
    handlers: { email: string; name: string; files: number }[];
    from: string;
    to: string;
    busy: boolean;
  }>(null);
  const openHandover = async () => {
    try {
      const res = await fetch("/api/admin/messages/handover", { cache: "no-store" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not load staff");
      setHandover({ staff: json.staff, handlers: json.handlers, from: json.handlers[0]?.email ?? "", to: "", busy: false });
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not load staff", true);
    }
  };
  const runHandover = async () => {
    if (!handover?.from || !handover.to) return;
    setHandover({ ...handover, busy: true });
    try {
      const res = await fetch("/api/admin/messages/handover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: handover.from, to: handover.to }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not move the files");
      setHandover(null);
      flash(`${json.moved} file chat${json.moved === 1 ? "" : "s"} handed over`);
      await Promise.all([loadList(), activeId ? loadDetail(activeId, true) : Promise.resolve()]);
    } catch (err) {
      setHandover((h) => (h ? { ...h, busy: false } : h));
      flash(err instanceof Error ? err.message : "Could not move the files", true);
    }
  };

  const filters: { id: Filter; label: string }[] = [
    { id: "open", label: "Open" },
    { id: "mine", label: "Mine" },
    { id: "unassigned", label: "Unhandled" },
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
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h1 className="text-lg font-bold text-slate-900">File chats</h1>
              <span className="text-xs text-slate-500">{counts.open} open</span>
            </div>
            <button
              onClick={() => void openHandover()}
              title="Move all of one person's file chats to someone else"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 text-[12.5px] font-medium text-slate-700 hover:bg-slate-50"
            >
              <Users size={14} /> Hand over files
            </button>
          </div>
          <div className="relative">
            <label htmlFor="conv-search" className="sr-only">Search conversations</label>
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              id="conv-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search file no., address, client or message"
              className="h-9 w-full rounded-lg border border-slate-300 bg-slate-50 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary/30"
            />
          </div>
          {/* Tabs size to their label + count (no wrapping), sharing the row. */}
          <div className="flex gap-0.5 rounded-lg bg-slate-100 p-1">
            {filters.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                aria-pressed={filter === f.id}
                className={`flex h-8 flex-auto items-center justify-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12px] font-medium transition-all ${
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
                      <span className="relative flex h-10 w-10 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                        <FolderOpen size={18} />
                        {r.client_online && (
                          <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500">
                            <span className="sr-only">Client online</span>
                          </span>
                        )}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm ${r.unread ? "font-bold" : "font-semibold"} text-slate-900`}>
                            {fileTitle(r.file_number)}
                          </span>
                          <span className={`flex-none text-[11.5px] ${r.unread ? "font-semibold text-brand-primary" : "text-slate-400"}`}>{relTime(r.last_at)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          {typing[r.id] ? (
                            <span className="min-w-0 flex-1 truncate text-[13px] italic text-emerald-700">typing…</span>
                          ) : (
                            <span className={`min-w-0 flex-1 truncate text-[13px] ${r.unread ? "font-medium text-slate-900" : "text-slate-500"}`}>{r.preview}</span>
                          )}
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
                          <span className="min-w-0 truncate">
                            {r.name}
                            {r.co_count > 0 && ` +${r.co_count}`}
                          </span>
                          <span aria-hidden className="flex-none">·</span>
                          <span className={`flex-none whitespace-nowrap ${r.assignee_name ? "" : "italic text-slate-400"}`}>
                            {r.assignee_name ? (mine(r) ? "You" : r.assignee_name.split(" ")[0]) : "Unhandled"}
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
            <p className="font-semibold text-slate-800">Select a file chat</p>
            <p className="max-w-xs text-sm">Each file has one chat that stays with the file. Replies are emailed to the clients, who can answer by email or in their portal.</p>
          </div>
        ) : (
          <>
            <header className="flex min-h-[68px] flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
              <button onClick={() => setActiveId(null)} aria-label="Back to conversations" className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden">
                <ArrowLeft size={18} />
              </button>
              <span className="relative flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                <FolderOpen size={17} />
                {activeRow?.client_online && <span aria-hidden className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />}
              </span>
              <div className="min-w-[140px] flex-1">
                {/* The FILE is the title; the clients and their presence (one
                    dot on the icon, one word here) go underneath. Open needs no
                    marker (the Resolve button says it); Resolved gets a chip. */}
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-[15px] font-semibold text-slate-900" title={address ?? undefined}>
                    {fileName}
                  </h2>
                  {status === "resolved" && (
                    <span className="flex-none rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Resolved</span>
                  )}
                </div>
                <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-slate-500">
                  <span className="truncate">{clientNames}</span>
                  {clientPresence && (
                    <>
                      <span aria-hidden>·</span>
                      <span className={`flex-none ${activeRow?.client_online ? "font-medium text-emerald-700" : ""}`}>{clientPresence}</span>
                    </>
                  )}
                </p>
              </div>

              <div ref={assignRef} className="relative">
                <button
                  onClick={() => setAssignOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={assignOpen}
                  className="flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
                >
                  <UserPlus size={16} />
                  <span className="text-slate-500">Handled by</span>
                  <span>{assigneeEmail ? (assigneeEmail.toLowerCase() === myEmail ? "You" : (assigneeName ?? "").split(" ")[0] || assigneeEmail) : "nobody"}</span>
                  <ChevronDown size={14} />
                </button>
                {assignOpen && (
                  <div role="menu" className="absolute right-0 top-11 z-20 w-64 rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Who handles this file</p>
                    <p className="px-2.5 pb-1.5 text-[11.5px] leading-snug text-slate-500">The chat stays with the file, so whoever takes over sees all of it.</p>
                    <button
                      role="menuitemradio"
                      aria-checked={!assigneeEmail}
                      onClick={() => { setAssignOpen(false); void patch({ action: "assign", email: null }); }}
                      className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="flex-1 text-slate-600">Nobody yet</span>
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
                          {teamStatus[s.email.toLowerCase()] && teamStatus[s.email.toLowerCase()] !== "offline" && (
                            <span className="flex items-center gap-1 text-[11px] text-slate-500">
                              <span aria-hidden className={`h-2 w-2 rounded-full ${teamStatus[s.email.toLowerCase()] === "online" ? "bg-emerald-500" : "bg-amber-500"}`} />
                              {teamStatus[s.email.toLowerCase()] === "online" ? "Online" : "Away"}
                            </span>
                          )}
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
                  {activeTyping && (
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-9 items-center gap-1 rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-3.5 shadow-sm" aria-hidden>
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "-0.3s" }} />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: "-0.15s" }} />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" />
                      </span>
                      <span className="text-[11.5px] text-slate-500">{(activeTyping.name || firstName).split(" ")[0]} is typing…</span>
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
                  onChange={(e) => {
                    setDraft(e.target.value.slice(0, 5000));
                    if (e.target.value.trim() && !e.target.value.startsWith("/")) sendTyping();
                  }}
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

      {/* ── File details ── */}
      {activeId && (
        <aside aria-label="File details" className="hidden w-80 flex-none flex-col overflow-y-auto border-l border-slate-200 bg-slate-50/50 xl:flex">
          <div className="flex flex-col items-center gap-2.5 border-b border-slate-200 bg-white px-5 pb-5 pt-7 text-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100 text-slate-600">
              <FolderOpen size={26} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-slate-900">{fileName}</h2>
              {address && <p className="text-[13px] text-slate-500">{address}</p>}
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {status === "open" ? "Open chat" : "Resolved"}
            </span>
          </div>

          <section className="m-3 mb-0 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Clients on this file</h3>
            <ul className="space-y-2.5">
              {(people.length > 0 ? people : [{ name: title, email: null, phone: null, primary: true }]).map((p) => (
                <li key={p.name + (p.email ?? "")} className="flex items-center gap-2.5 text-[13px]">
                  <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tint(p.name)}`}>{initials(p.name)}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-slate-900">{p.name}</span>
                    {p.email && <span className="block truncate text-xs text-slate-500">{p.email}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {clientPresence && (
              <p className={`mt-3 text-xs ${activeRow?.client_online ? "font-medium text-emerald-700" : "text-slate-500"}`}>
                {activeRow?.client_online ? "Online in the portal now" : clientPresence}
              </p>
            )}
          </section>

          <section className="m-3 mb-0 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">Handled by</h3>
            {(detail?.handlers?.length ?? 0) === 0 ? (
              <p className="text-[13px] text-slate-500">
                {assigneeEmail ? `${assigneeName || assigneeEmail} (now)` : "Nobody has taken this file’s chat yet."}
              </p>
            ) : (
              <ol className="space-y-2">
                {detail!.handlers!.map((h, i) => (
                  <li key={h.email + h.started_at + i} className="flex items-baseline gap-2.5 text-[13px]">
                    <span aria-hidden className={`mt-1 h-2 w-2 flex-none rounded-full ${h.ended_at ? "bg-slate-300" : "bg-brand-primary"}`} />
                    <span className="min-w-0 flex-1 truncate text-slate-900">{h.email.toLowerCase() === myEmail ? "You" : h.name}</span>
                    <span className="flex-none text-xs text-slate-500">
                      {shortDate(h.started_at)} – {h.ended_at ? shortDate(h.ended_at) : "now"}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="m-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">File details</h3>
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

          <section className="mx-3 mb-3 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">The clients’ other files</h3>
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

      {handover && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && !handover.busy && setHandover(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="handover-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <div className="mb-1 flex items-center justify-between">
              <h2 id="handover-title" className="text-base font-bold text-slate-900">Hand over files</h2>
              <button onClick={() => !handover.busy && setHandover(null)} aria-label="Close" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
                <X size={18} />
              </button>
            </div>
            <p className="mb-4 text-[13px] leading-relaxed text-slate-600">
              Every file chat handled by one person moves to another — for someone leaving or going on leave. The chats stay
              with their files, so the new person sees each one’s full history.
            </p>
            {handover.handlers.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-3 text-[13px] text-slate-600">Nobody is handling any file chats right now.</p>
            ) : (
              <div className="space-y-3">
                <label className="block text-[13px] font-medium text-slate-700">
                  From
                  <select
                    value={handover.from}
                    onChange={(e) => setHandover({ ...handover, from: e.target.value })}
                    className="mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                  >
                    {handover.handlers.map((h) => {
                      const active = handover.staff.some((s) => s.email.toLowerCase() === h.email.toLowerCase());
                      return (
                        <option key={h.email} value={h.email}>
                          {h.name} — {h.files} file{h.files === 1 ? "" : "s"}
                          {active ? "" : " (no longer active)"}
                        </option>
                      );
                    })}
                  </select>
                </label>
                <label className="block text-[13px] font-medium text-slate-700">
                  To
                  <select
                    value={handover.to}
                    onChange={(e) => setHandover({ ...handover, to: e.target.value })}
                    className="mt-1 block h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm"
                  >
                    <option value="">Choose who takes over…</option>
                    {handover.staff
                      .filter((s) => s.email.toLowerCase() !== handover.from.toLowerCase())
                      .map((s) => (
                        <option key={s.email} value={s.email}>
                          {s.email.toLowerCase() === myEmail ? `You (${s.name || s.email})` : s.name || s.email}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setHandover(null)} disabled={handover.busy} className="h-9 rounded-lg border border-slate-300 bg-white px-3.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button
                onClick={() => void runHandover()}
                disabled={handover.busy || !handover.from || !handover.to}
                className="flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3.5 text-[13px] font-semibold text-white hover:bg-brand-primaryHover disabled:opacity-50"
              >
                {handover.busy && <Loader2 size={14} className="animate-spin" />}
                Move{" "}
                {handover.handlers.find((h) => h.email === handover.from)?.files ?? 0} file chat
                {(handover.handlers.find((h) => h.email === handover.from)?.files ?? 0) === 1 ? "" : "s"}
              </button>
            </div>
          </div>
        </div>
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
