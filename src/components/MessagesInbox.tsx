"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleCheck,
  Copy,
  Download,
  FileText,
  Lock,
  Loader2,
  Mail,
  MessageSquare,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Reply,
  RotateCcw,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
  X,
  Zap,
} from "lucide-react";
import { upload } from "@vercel/blob/client";
import { useAuth } from "@/lib/AuthProvider";
import { useChatChannel } from "@/hooks/useChatChannel";
import { BLOB_ACCESS } from "@/lib/blobPrivacy";
import {
  CHAT_ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS_PER_MESSAGE,
  chatAttachmentPath,
  attachmentSummary,
  checkChatAttachment,
  dragHasFiles,
  formatAttachmentSize,
  nameClipboardFile,
  isImageAttachment,
  type ChatAttachment,
} from "@/lib/chatAttachments";
import AttachmentViewer from "@/components/chat/AttachmentViewer";

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
  sender_email: string | null;
  body: string;
  source: "portal" | "email";
  created_at: string;
  read_by_client_at: string | null;
  attachments: ChatAttachment[];
  edited_at: string | null;
  deleted_at: string | null;
  reply_to_id?: string | null;
};

/** One line of a message, for a quote ("Replying to …" bar and the quote in a bubble). */
function quoteText(m: Pick<Msg, "body" | "attachments" | "deleted_at">): string {
  if (m.deleted_at) return "This message was deleted";
  const line = m.body.replace(/\s+/g, " ").trim();
  if (line) return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  return attachmentSummary(m.attachments) || "Message";
}

type SavedReply = { id: string; shortcut: string; title: string; body: string };

/** A file picked in the composer: uploading, then ready to send with the message. */
type Pending = { key: string; name: string; size: number; status: "uploading" | "ready" | "error"; url?: string; type?: string; error?: string };

type Detail = {
  messages: Msg[];
  conversation: { status: "open" | "resolved"; assignee_email: string | null; assignee_name: string | null; rating: number | null; rating_comment: string | null } | null;
  people: { name: string; email: string | null; phone: string | null; primary: boolean }[];
  file: { deal_id: string; file_number: string | null; type: string | null; status: string | null; property_address: string | null; closing_date: string | null } | null;
  other_files: { id: string; file_number: string | null; property_address: string | null }[];
  staff: { name: string; email: string }[];
  handlers?: { name: string; email: string; started_at: string; ended_at: string | null }[];
};

/** "26S-0368 · 12 King St" — the file, shown under the client's name. */
function fileLine(fileNumber: string | null | undefined, address?: string | null): string {
  return [fileNumber || "No file no. yet", address].filter(Boolean).join(" · ");
}

/**
 * Shows `full` (every client's name) when it fits the space it has, otherwise
 * `short` ("Vivek +1") — never a half-cut list of names.
 */
const FitName: React.FC<{ full: string; short: string; className?: string }> = ({ full, short, className = "" }) => {
  const box = useRef<HTMLSpanElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const check = () => {
      if (box.current && probe.current) setFits(probe.current.offsetWidth <= box.current.clientWidth);
    };
    check();
    if (typeof ResizeObserver === "undefined" || !box.current) return;
    const ro = new ResizeObserver(check);
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [full]);
  return (
    <span ref={box} className={`relative block min-w-0 flex-1 ${className}`}>
      <span ref={probe} aria-hidden className={`invisible absolute left-0 top-0 whitespace-nowrap ${className}`}>{full}</span>
      <span className="block truncate">{fits ? full : short}</span>
    </span>
  );
};

/**
 * WhatsApp-style round avatar: the client's initials in their own colour, an
 * "+N" disc behind it for co-clients, and the green dot when they're online.
 */
const ClientAvatar: React.FC<{ name: string; co?: number; online?: boolean; size?: "sm" | "md" | "lg" }> = ({ name, co = 0, online, size = "md" }) => {
  const box = size === "lg" ? "h-20 w-20 text-2xl" : size === "sm" ? "h-9 w-9 text-[13px]" : "h-10 w-10 text-sm";
  return (
    <span className="relative flex flex-none">
      {co > 0 && (
        <span aria-hidden className={`absolute -right-1.5 top-0 flex items-center justify-center rounded-full border-2 border-white bg-slate-200 font-semibold text-slate-600 ${size === "lg" ? "h-8 w-8 text-xs" : "h-5 w-5 text-[9px]"}`}>
          +{co}
        </span>
      )}
      <span className={`relative flex items-center justify-center rounded-full font-semibold ${box} ${tint(name)}`}>{initials(name)}</span>
      {online && (
        <span className={`absolute bottom-0 right-0 rounded-full border-2 border-white bg-emerald-500 ${size === "lg" ? "h-4 w-4" : "h-3 w-3"}`}>
          <span className="sr-only">Client online</span>
        </span>
      )}
    </span>
  );
};

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
}

type Filter = "open" | "mine" | "unassigned" | "resolved";

/** Where a chat attachment opens (thread-scoped, auth-gated). */
function attachmentHref(rootId: string, a: ChatAttachment, download = false): string {
  return `/api/admin/messages/${rootId}/attachment?u=${encodeURIComponent(a.url)}${download ? "&download=1" : ""}`;
}

/**
 * Thumbnails for images, file cards for everything else. Clicking OPENS the
 * file in the viewer (WhatsApp-style); only the ⬇ icon downloads.
 * `onDark` = inside a staff (brand) bubble.
 */
const AttachmentList: React.FC<{
  rootId: string;
  items: ChatAttachment[];
  onDark?: boolean;
  onOpen: (items: ChatAttachment[], index: number) => void;
}> = ({ rootId, items, onDark = false, onOpen }) => {
  if (items.length === 0) return null;
  return (
    // Fixed-width rows whose names truncate, so a long filename can't widen the bubble.
    <div className="mt-1.5 flex w-72 max-w-full flex-col gap-1.5">
      {items.map((a, i) =>
        isImageAttachment(a) ? (
          // Thumbnail at the image's own size, capped — never stretched up.
          <button
            key={a.url}
            type="button"
            onClick={() => onOpen(items, i)}
            title={`Open ${a.name}`}
            className="block w-fit max-w-full overflow-hidden rounded-lg border border-slate-200 hover:opacity-90"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated route, not a static asset */}
            <img src={attachmentHref(rootId, a)} alt={a.name} loading="lazy" className="block h-auto max-h-48 w-auto max-w-[240px] object-contain" />
          </button>
        ) : (
          <div
            key={a.url}
            className={`flex w-full min-w-0 items-center rounded-lg ${onDark ? "bg-white/15" : "border border-slate-200 bg-slate-50"}`}
          >
            <button
              type="button"
              onClick={() => onOpen(items, i)}
              title={`Open ${a.name}`}
              className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-2.5 py-2 text-left ${onDark ? "hover:bg-white/10" : "hover:bg-slate-100"}`}
            >
              <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-md ${onDark ? "bg-white text-brand-primary" : "bg-brand-primary/10 text-brand-primary"}`}>
                <FileText size={16} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className={`truncate text-[13px] font-medium ${onDark ? "text-white" : "text-slate-800"}`}>{a.name}</span>
                <span className={`text-[11px] ${onDark ? "text-white/75" : "text-slate-500"}`}>{formatAttachmentSize(a.size)}</span>
              </span>
            </button>
            <a
              href={attachmentHref(rootId, a, true)}
              download={a.name}
              aria-label={`Download ${a.name}`}
              title="Download"
              className={`mr-1 flex h-8 w-8 flex-none items-center justify-center rounded-md ${onDark ? "text-white hover:bg-white/15" : "text-slate-500 hover:bg-slate-200 hover:text-slate-800"}`}
            >
              <Download size={15} />
            </a>
          </div>
        ),
      )}
    </div>
  );
};

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

/**
 * Add / edit / delete the "/" saved replies (shared by all staff). Read-only
 * with a note while the table doesn't exist yet (migration not run).
 */
const SavedRepliesManager: React.FC<{
  replies: SavedReply[];
  editable: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  flash: (text: string, error?: boolean) => void;
}> = ({ replies, editable, onClose, onChanged, flash }) => {
  // null = list view; { id: null } = adding; { id } = editing that reply.
  const [form, setForm] = useState<null | { id: string | null; shortcut: string; title: string; body: string }>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const call = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not save");
      await onChanged();
      return true;
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not save", true);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const payload = { shortcut: form.shortcut, title: form.title, body: form.body };
    const ok = form.id
      ? await call(`/api/admin/messages/saved-replies/${form.id}`, "PATCH", payload)
      : await call("/api/admin/messages/saved-replies", "POST", payload);
    if (ok) {
      setForm(null);
      flash("Saved reply updated");
    }
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    if (await call(`/api/admin/messages/saved-replies/${id}`, "DELETE")) flash("Saved reply deleted");
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby="saved-title" className="flex max-h-full w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 id="saved-title" className="text-base font-bold text-slate-900">Saved replies</h2>
          <button onClick={() => !busy && onClose()} aria-label="Close" className="rounded-lg p-1 text-slate-500 hover:bg-slate-100">
            <X size={18} />
          </button>
        </div>

        {form ? (
          <div className="space-y-3 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
              <label className="block text-[13px] font-medium text-slate-700">
                Shortcut
                <input
                  value={form.shortcut}
                  onChange={(e) => setForm({ ...form, shortcut: e.target.value.slice(0, 31) })}
                  placeholder="/docs"
                  className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 font-mono text-sm"
                />
              </label>
              <label className="block text-[13px] font-medium text-slate-700">
                Title
                <input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value.slice(0, 80) })}
                  placeholder="Documents reminder"
                  className="mt-1 block h-10 w-full rounded-lg border border-slate-300 px-3 text-sm"
                />
              </label>
            </div>
            <label className="block text-[13px] font-medium text-slate-700">
              Reply
              <textarea
                rows={5}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value.slice(0, 5000) })}
                className="mt-1 block w-full resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <p className="text-xs text-slate-500">
              Write <code className="rounded bg-slate-100 px-1">{"{name}"}</code> where the client’s first name should go.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setForm(null)} disabled={busy} className="h-9 rounded-lg border border-slate-300 bg-white px-3.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
                Back
              </button>
              <button
                onClick={() => void save()}
                disabled={busy || !form.shortcut.trim() || !form.title.trim() || !form.body.trim()}
                className="flex h-9 items-center gap-2 rounded-lg bg-brand-primary px-3.5 text-[13px] font-semibold text-white hover:bg-brand-primaryHover disabled:opacity-50"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {form.id ? "Save changes" : "Add reply"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {!editable && (
              <p className="mx-5 mt-4 rounded-lg bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
                These are the built-in replies. They can be edited once the chat migration has been run.
              </p>
            )}
            <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto px-2 py-2">
              {replies.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-500">No saved replies yet.</li>}
              {replies.map((r) => (
                <li key={r.id} className="flex items-start gap-3 px-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="font-mono text-[12.5px] font-medium text-brand-primary">{r.shortcut}</span>
                      <span className="truncate text-[13.5px] font-medium text-slate-900">{r.title}</span>
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{r.body}</p>
                  </div>
                  {editable &&
                    (confirmId === r.id ? (
                      <span className="flex flex-none items-center gap-1 text-[12px]">
                        <button onClick={() => void remove(r.id)} disabled={busy} className="rounded px-1.5 py-1 font-semibold text-red-600 hover:bg-red-50">Delete</button>
                        <button onClick={() => setConfirmId(null)} className="rounded px-1.5 py-1 text-slate-600 hover:bg-slate-100">Cancel</button>
                      </span>
                    ) : (
                      <span className="flex flex-none gap-0.5">
                        <button onClick={() => setForm({ id: r.id, shortcut: r.shortcut, title: r.title, body: r.body })} aria-label={`Edit ${r.shortcut}`} className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => setConfirmId(r.id)} aria-label={`Delete ${r.shortcut}`} className="rounded-md p-1.5 text-slate-500 hover:bg-red-50 hover:text-red-600">
                          <Trash2 size={14} />
                        </button>
                      </span>
                    ))}
                </li>
              ))}
            </ul>
            {editable && (
              <div className="flex justify-end border-t border-slate-100 px-5 py-3">
                <button
                  onClick={() => setForm({ id: null, shortcut: "/", title: "", body: "" })}
                  className="flex h-9 items-center gap-1.5 rounded-lg bg-brand-primary px-3.5 text-[13px] font-semibold text-white hover:bg-brand-primaryHover"
                >
                  <Plus size={15} /> New reply
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

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
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);
  const [savedEditable, setSavedEditable] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const savedPopRef = useRef<HTMLDivElement>(null);
  const savedBtnRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [files, setFiles] = useState<Pending[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<{ id: string; text: string; busy: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // The ⌄ menu on one of my messages, and the file viewer.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<{ items: ChatAttachment[]; index: number } | null>(null);
  // Contact info panel (click the client's avatar/name). Always shown on xl;
  // below that it slides over the thread, WhatsApp-style.
  const [profileOpen, setProfileOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // The message the composer is answering (WhatsApp "Reply"), and a file drag in progress.
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [flashId, setFlashId] = useState<string | null>(null);

  // Close the message menu on a click outside it, or on Escape.
  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

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

  const loadSavedReplies = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/messages/saved-replies", { cache: "no-store" });
      const json = await res.json();
      if (json.success) {
        setSavedReplies(json.data as SavedReply[]);
        setSavedEditable(!!json.editable);
      }
    } catch {
      /* keep what we have */
    }
  }, []);
  useEffect(() => {
    void loadSavedReplies();
  }, [loadSavedReplies]);

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
      // File no., address or client — not message text (it only ever saw the
      // latest message, so it found some chats and silently missed others).
      return (
        r.name.toLowerCase().includes(q) ||
        (r.file_number ?? "").toLowerCase().includes(q) ||
        (r.property_address ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, filter, search, mine]);

  const activeRow = rows.find((r) => r.id === activeId) ?? null;
  const people = detail?.people ?? [];
  // The CLIENT is the title (avatar, saved-reply {name}); the FILE goes underneath.
  const title = activeRow?.name ?? people[0]?.name ?? "Client";
  const coCount = people.length > 1 ? people.length - 1 : activeRow?.co_count ?? 0;
  const clientTitle = title + (coCount ? ` +${coCount}` : "");
  const fileName = fileLine(detail?.file?.file_number ?? activeRow?.file_number);
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
    setFiles([]);
    setEditing(null);
    setConfirmDelete(null);
    setSavedOpen(false);
    setMenuFor(null);
    setViewer(null);
    setReplyTo(null);
    setProfileOpen(false);
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, unread: 0 } : r)));
  };

  // Answer one message. A private note can only be answered with a note (a
  // reply would show its text to the client), so that switches the composer.
  const startReply = (m: Msg) => {
    setMenuFor(null);
    setEditing(null);
    setReplyTo(m);
    if (m.kind === "note") setMode("note");
    setTimeout(() => composerRef.current?.focus(), 0);
  };
  // Jump to the quoted original and flash it.
  const jumpTo = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashId(id);
    setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1600);
  };

  // Files dragged onto the open chat. The depth counter stops the overlay
  // flickering as the pointer crosses child elements.
  const dropProps = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (dragHasFiles(e)) e.preventDefault();
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
  };

  // The saved-replies list is open (the button, or "/" typed at the start of the
  // box). It closes on a click anywhere else, Escape, or picking a reply.
  const showSaved = savedOpen && mode === "reply";
  const shortcutMatches = useMemo(() => {
    if (!showSaved) return [];
    // Typing "/hi" filters; opened from the button with other text, show them all.
    const q = draft.startsWith("/") && !draft.includes(" ") ? draft.slice(1).toLowerCase() : "";
    return savedReplies.filter((k) => k.shortcut.slice(1).startsWith(q) || k.title.toLowerCase().includes(q));
  }, [draft, showSaved, savedReplies]);

  useEffect(() => {
    if (!savedOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (savedPopRef.current?.contains(t) || savedBtnRef.current?.contains(t) || composerRef.current?.contains(t)) return;
      setSavedOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSavedOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [savedOpen]);

  const firstName = (people[0]?.name ?? "").split(" ")[0] || "there";
  const insertSaved = (k: SavedReply) => {
    const text = k.body.replace(/\{name\}/g, firstName);
    // A "/hi" query is replaced by the reply; anything already written is kept.
    setDraft((d) => (d.startsWith("/") && !d.includes(" ") ? text : d.trim() ? `${d.trimEnd()}\n${text}` : text));
    setSavedOpen(false);
    composerRef.current?.focus();
  };

  // Attachments upload as soon as they're picked (📎), dropped on the chat, or
  // pasted (a screenshot), straight to Blob, so Send only carries their URLs.
  // The server re-checks each one before storing it.
  const addFiles = (list: FileList | File[] | null) => {
    if (!list || list.length === 0 || !activeId) return;
    const root = activeId;
    const room = MAX_ATTACHMENTS_PER_MESSAGE - files.length;
    const all = Array.from(list).map(nameClipboardFile);
    const picked = all.slice(0, Math.max(0, room));
    if (all.length > picked.length) flash(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`, true);
    for (const file of picked) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const problem = checkChatAttachment(file);
      if (problem) {
        flash(problem, true);
        continue;
      }
      setFiles((f) => [...f, { key, name: file.name, size: file.size, status: "uploading" }]);
      void upload(chatAttachmentPath(root, file.name), file, {
        access: BLOB_ACCESS,
        handleUploadUrl: `/api/admin/messages/${root}/attachment/token`,
        contentType: file.type || undefined,
      })
        .then((blob) =>
          setFiles((f) => f.map((p) => (p.key === key ? { ...p, status: "ready", url: blob.url, type: blob.contentType } : p))),
        )
        .catch((err: unknown) =>
          setFiles((f) =>
            f.map((p) => (p.key === key ? { ...p, status: "error", error: err instanceof Error ? err.message : "Upload failed" } : p)),
          ),
        );
    }
  };
  const uploadingFiles = files.some((f) => f.status === "uploading");
  const readyFiles = files.filter((f) => f.status === "ready" && f.url);

  const send = async () => {
    const body = draft.trim();
    if ((!body && readyFiles.length === 0) || sending || uploadingFiles || !activeId) return;
    setSending(true);
    try {
      const res = await fetch(`/api/admin/messages/${activeId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          kind: mode === "note" ? "note" : "message",
          attachments: readyFiles.map((f) => ({ url: f.url, name: f.name })),
          ...(replyTo ? { reply_to_id: replyTo.id } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not send");
      setDraft("");
      setFiles([]);
      setReplyTo(null);
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

  // Edit / delete one of MY replies or notes.
  const changeMessage = async (id: string, method: "PATCH" | "DELETE", body?: string) => {
    if (!activeId) return false;
    try {
      const res = await fetch(`/api/admin/messages/${activeId}/messages/${id}`, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify({ body }) } : {}),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Could not update the message");
      await Promise.all([loadDetail(activeId, true), loadList()]);
      return true;
    } catch (err) {
      flash(err instanceof Error ? err.message : "Could not update the message", true);
      return false;
    }
  };
  const saveEdit = async () => {
    if (!editing || editing.busy) return;
    setEditing({ ...editing, busy: true });
    const ok = await changeMessage(editing.id, "PATCH", editing.text);
    setEditing((e) => (ok ? null : e ? { ...e, busy: false } : e));
  };
  const removeMessage = async (id: string) => {
    setConfirmDelete(null);
    if (await changeMessage(id, "DELETE")) flash("Message deleted");
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

  /** Only my own, live replies / notes can be edited or deleted. */
  const isMine = (m: Msg) =>
    !!myEmail &&
    m.sender_type === "admin" &&
    (m.kind === "message" || m.kind === "note") &&
    !m.deleted_at &&
    (m.sender_email ?? "").toLowerCase() === myEmail;

  // WhatsApp-style ⌄ beside every bubble (on hover; always shown on touch
  // screens): Reply on any message, Edit / Delete on my own. Delete confirms in
  // a popup. `side` = which side of the bubble the ⌄ sits on.
  const renderActions = (m: Msg, side: "left" | "right" = "left") => {
    if (m.deleted_at || editing?.id === m.id || (m.kind !== "message" && m.kind !== "note")) return null;
    const open = menuFor === m.id;
    const own = isMine(m);
    return (
      <div ref={open ? menuRef : undefined} className="relative flex-none self-start pt-1">
        <button
          onClick={() => setMenuFor(open ? null : m.id)}
          aria-label="Message options"
          aria-haspopup="menu"
          aria-expanded={open}
          className={`flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-opacity hover:bg-slate-200/70 hover:text-slate-800 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${
            open ? "bg-slate-200/70 opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <ChevronDown size={16} />
        </button>
        {open && (
          <div role="menu" className={`absolute top-9 z-20 w-36 rounded-xl border border-slate-200 bg-white p-1 shadow-xl ${side === "left" ? "right-0" : "left-0"}`}>
            <button
              role="menuitem"
              onClick={() => startReply(m)}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-slate-700 hover:bg-slate-50"
            >
              <Reply size={14} /> Reply
            </button>
            {own && (
              <>
            <button
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                setEditing({ id: m.id, text: m.body, busy: false });
              }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-slate-700 hover:bg-slate-50"
            >
              <Pencil size={14} /> Edit
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenuFor(null);
                setConfirmDelete(m.id);
              }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-red-600 hover:bg-red-50"
            >
              <Trash2 size={14} /> Delete
            </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  };
  const deleting =confirmDelete ? detail?.messages.find((x) => x.id === confirmDelete) ?? null : null;

  const byId = new Map((detail?.messages ?? []).map((x) => [x.id, x]));
  /** Who wrote a quoted message, as the quote's heading. */
  const quotedName = (q: Msg) =>
    isMine(q) || (q.sender_type === "admin" && (q.sender_email ?? "").toLowerCase() === myEmail && !!myEmail)
      ? "You"
      : q.sender_name || (q.sender_type === "client" ? "Client" : "iClosed Team");

  // Body + attachments of one bubble, or its inline editor, or the deleted marker.
  const renderContent = (m: Msg, tone: "staff" | "client" | "note") => {
    if (m.deleted_at) return <p className="italic text-slate-500">This message was deleted</p>;
    if (editing?.id === m.id) {
      return (
        <div className="flex w-[min(28rem,60vw)] flex-col gap-2">
          <label htmlFor={`edit-${m.id}`} className="sr-only">Edit message</label>
          <textarea
            id={`edit-${m.id}`}
            autoFocus
            rows={3}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value.slice(0, 5000) })}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(null);
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void saveEdit();
              }
            }}
            className="w-full resize-y rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-brand-primary/30"
          />
          <div className="flex items-center justify-end gap-2 text-[12.5px]">
            {m.kind === "message" && <span className="mr-auto text-slate-500">The client was already emailed the original.</span>}
            <button onClick={() => setEditing(null)} className="rounded-md px-2.5 py-1 text-slate-600 hover:bg-slate-100">Cancel</button>
            <button
              onClick={() => void saveEdit()}
              disabled={editing.busy || (!editing.text.trim() && m.attachments.length === 0)}
              className="flex items-center gap-1.5 rounded-md bg-brand-primary px-2.5 py-1 font-semibold text-white hover:bg-brand-primaryHover disabled:opacity-50"
            >
              {editing.busy && <Loader2 size={12} className="animate-spin" />} Save
            </button>
          </div>
        </div>
      );
    }
    const quoted = m.reply_to_id ? byId.get(m.reply_to_id) : undefined;
    return (
      <>
        {m.reply_to_id && (
          <button
            type="button"
            onClick={() => quoted && jumpTo(quoted.id)}
            title={quoted ? "Go to the original message" : undefined}
            className={`mb-1.5 block w-full min-w-0 rounded-md border-l-[3px] px-2.5 py-1.5 text-left text-[12.5px] leading-snug ${
              tone === "staff"
                ? "border-white/70 bg-white/15 text-white hover:bg-white/20"
                : tone === "note"
                  ? "border-amber-500 bg-amber-100/70 text-amber-950 hover:bg-amber-100"
                  : "border-brand-primary bg-slate-100 text-slate-700 hover:bg-slate-200/70"
            }`}
          >
            <span className="block truncate font-semibold">{quoted ? quotedName(quoted) : "Original message"}</span>
            <span className={`block truncate ${tone === "staff" ? "text-white/85" : "opacity-80"}`}>
              {quoted ? quoteText(quoted) : "Not loaded"}
            </span>
          </button>
        )}
        {m.body && <p className={`whitespace-pre-wrap break-words ${tone === "note" ? "text-sm text-amber-950" : ""}`}>{m.body}</p>}
        {activeId && (
          <AttachmentList rootId={activeId} items={m.attachments} onDark={tone === "staff"} onOpen={(items, index) => setViewer({ items, index })} />
        )}
      </>
    );
  };

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
              placeholder="Search file no., address or client"
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
                      <ClientAvatar name={r.name} online={r.client_online} />
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <span className={`min-w-0 flex-1 truncate text-sm ${r.unread ? "font-bold" : "font-semibold"} text-slate-900`}>
                            {r.name}
                            {r.co_count > 0 && <span className="font-normal text-slate-500"> +{r.co_count}</span>}
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
                          <span className="min-w-0 truncate" title={r.property_address ?? undefined}>
                            {r.file_number ?? "No file no. yet"}
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
      <main className={`${activeId ? "flex" : "hidden lg:flex"} relative min-w-0 flex-1 flex-col`} {...(activeId ? dropProps : {})}>
        {dragging && activeId && (
          <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-brand-primary bg-white/90 text-brand-primary">
            <Paperclip size={28} />
            <p className="text-sm font-semibold">Drop files to attach</p>
            <p className="text-xs text-slate-500">Images, PDF, Word or Excel · up to 10 MB each</p>
          </div>
        )}
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
              {/* The CLIENT is the title (WhatsApp-style); the file and their
                  presence go underneath. Clicking opens Contact info. Open needs
                  no marker (the Resolve button says it); Resolved gets a chip. */}
              <button
                onClick={() => setProfileOpen((v) => !v)}
                aria-label={`Contact info for ${clientTitle}`}
                aria-expanded={profileOpen}
                className="flex min-w-[140px] flex-1 items-center gap-3 rounded-lg py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/40"
              >
                <ClientAvatar name={title} online={activeRow?.client_online} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <FitName
                      full={people.length > 1 ? people.map((p) => p.name).join(", ") : clientTitle}
                      short={clientTitle}
                      className="text-[15px] font-semibold text-slate-900"
                    />
                    {status === "resolved" && (
                      <span className="flex-none rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Resolved</span>
                    )}
                  </span>
                  {/* Only the client's presence here (WhatsApp-style); the file is in Contact info. */}
                  {clientPresence && (
                    <span className={`block truncate text-xs ${activeRow?.client_online ? "font-medium text-emerald-700" : "text-slate-500"}`}>{clientPresence}</span>
                  )}
                </span>
              </button>

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
                          <div id={`msg-${m.id}`} className={`group flex max-w-[78%] scroll-mt-4 items-start gap-1 self-end rounded-2xl transition-shadow ${flashId === m.id ? "ring-2 ring-amber-300 ring-offset-2" : ""}`}>
                            {renderActions(m)}
                            <div className="min-w-0 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-2.5">
                              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-amber-800">
                                <Lock size={12} /> Private note · {m.sender_name} · {clock(m.created_at)}
                                {m.edited_at && !m.deleted_at && <span className="font-normal">· edited</span>}
                              </p>
                              {renderContent(m, "note")}
                            </div>
                          </div>
                        ) : m.sender_type === "client" ? (
                          <div id={`msg-${m.id}`} className={`group flex max-w-[78%] scroll-mt-4 items-end gap-2.5 rounded-2xl transition-shadow ${flashId === m.id ? "ring-2 ring-amber-300 ring-offset-2" : ""}`}>
                            <span className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tint(m.sender_name || "c")}`}>{initials(m.sender_name || "C")}</span>
                            <div className="min-w-0">
                              <div className="min-w-0 max-w-full rounded-2xl rounded-bl-sm border border-slate-200 bg-white px-4 py-2.5 text-sm leading-relaxed text-slate-900 shadow-sm">{renderContent(m, "client")}</div>
                              <p className="mt-1 flex items-center gap-1 pl-1 text-[11.5px] text-slate-500">
                                {m.sender_name} · {clock(m.created_at)}
                                {m.edited_at && !m.deleted_at && " · edited"}
                                {m.source === "email" && (<><span aria-hidden>·</span><Mail size={11} /> by email</>)}
                              </p>
                            </div>
                            <div className="self-start">{renderActions(m, "right")}</div>
                          </div>
                        ) : (
                          <div id={`msg-${m.id}`} className={`group flex max-w-[78%] scroll-mt-4 items-start gap-1 self-end rounded-2xl transition-shadow ${flashId === m.id ? "ring-2 ring-amber-300 ring-offset-2" : ""}`}>
                            {renderActions(m)}
                            <div className="flex min-w-0 flex-col items-end">
                              <div
                                className={`min-w-0 max-w-full rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
                                  m.deleted_at ? "border border-slate-200 bg-white text-slate-500" : editing?.id === m.id ? "border border-slate-300 bg-white text-slate-900" : "bg-brand-primary text-white"
                                }`}
                              >
                                {renderContent(m, "staff")}
                              </div>
                              <p className="mt-1 pr-1 text-[11.5px] text-slate-500">
                                {m.sender_name} · {clock(m.created_at)}
                                {m.edited_at && !m.deleted_at && " · edited"}
                                {m.id === lastAdminId && !m.deleted_at && (m.read_by_client_at ? " · Seen" : " · Delivered")}
                              </p>
                            </div>
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
              {showSaved && (
                <div ref={savedPopRef} role="listbox" aria-label="Saved replies" className="absolute inset-x-4 bottom-[calc(100%-4px)] z-20 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl sm:inset-x-5">
                  <div className="flex items-center justify-between gap-2 px-2.5 pb-1 pt-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Saved replies</span>
                    <button onClick={() => { setSavedOpen(false); setManageOpen(true); }} className="text-[11px] font-semibold text-brand-primary hover:underline">Manage</button>
                  </div>
                  {shortcutMatches.length === 0 && (
                    <p className="px-2.5 py-3 text-[13px] text-slate-500">No saved replies match. Use Manage to add one.</p>
                  )}
                  {shortcutMatches.map((k) => (
                    <button key={k.id} onClick={() => insertSaved(k)} className="flex w-full flex-col items-start rounded-lg px-2.5 py-2 text-left hover:bg-slate-50">
                      <span className="flex items-baseline gap-2"><span className="font-mono text-[12.5px] font-medium text-brand-primary">{k.shortcut}</span><span className="text-[13.5px] font-medium text-slate-900">{k.title}</span></span>
                      <span className="max-w-full truncate text-xs text-slate-500">{k.body}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className={`rounded-xl border ${mode === "note" ? "border-amber-300 bg-amber-50" : "border-slate-300 bg-white"} focus-within:ring-2 focus-within:ring-brand-primary/20`}>
                <div className="flex gap-0.5 px-1.5 pt-1.5">
                  <button
                    onClick={() => {
                      setMode("reply");
                      // A quoted private note can't go out in a client reply.
                      if (replyTo?.kind === "note") setReplyTo(null);
                    }}
                    aria-pressed={mode === "reply"}
                    className={`h-[30px] rounded-md px-2.5 text-[13px] font-medium ${mode === "reply" ? "bg-slate-100 text-slate-900" : "text-slate-500 hover:bg-slate-50"}`}
                  >
                    Reply
                  </button>
                  <button onClick={() => { setMode("note"); setSavedOpen(false); }} aria-pressed={mode === "note"} className={`flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium ${mode === "note" ? "bg-amber-100 text-amber-900" : "text-slate-500 hover:bg-slate-50"}`}><Lock size={12} /> Private note</button>
                </div>
                {replyTo && (
                  <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg border-l-[3px] border-brand-primary bg-slate-50 py-1.5 pl-2.5 pr-1.5">
                    <Reply size={14} className="mt-0.5 flex-none text-brand-primary" />
                    <button type="button" onClick={() => jumpTo(replyTo.id)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[12.5px] font-semibold text-slate-800">Replying to {quotedName(replyTo)}</span>
                      <span className="block truncate text-[12.5px] text-slate-500">{quoteText(replyTo)}</span>
                    </button>
                    <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel reply" className="flex-none rounded p-1 text-slate-500 hover:bg-slate-200">
                      <X size={14} />
                    </button>
                  </div>
                )}
                <label htmlFor="composer" className="sr-only">{mode === "note" ? "Private note" : "Reply to the client"}</label>
                <textarea
                  id="composer"
                  ref={composerRef}
                  rows={3}
                  value={draft}
                  onPaste={(e) => {
                    // A pasted screenshot / copied file becomes an attachment; pasted text stays text.
                    const pasted = Array.from(e.clipboardData?.files ?? []);
                    if (pasted.length === 0) return;
                    e.preventDefault();
                    addFiles(pasted);
                  }}
                  onChange={(e) => {
                    const v = e.target.value.slice(0, 5000);
                    setDraft(v);
                    // "/" at the start opens the list; ordinary typing closes it.
                    setSavedOpen(v.startsWith("/") && !v.includes(" "));
                    if (v.trim() && !v.startsWith("/")) sendTyping();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && replyTo && !showSaved) setReplyTo(null);
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (showSaved && draft.startsWith("/") && shortcutMatches.length > 0) insertSaved(shortcutMatches[0]);
                      else void send();
                    }
                  }}
                  placeholder={mode === "note" ? "Write a private note — only staff can see it" : "Reply to the client — they’ll be emailed. Type / for saved replies"}
                  className="block min-h-[76px] w-full resize-none rounded-b-xl bg-transparent px-3.5 py-2.5 text-sm text-slate-900 outline-none"
                />
                {files.length > 0 && (
                  <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-3 pb-2">
                    {files.map((f) => (
                      <li
                        key={f.key}
                        title={f.error}
                        className={`flex max-w-[16rem] items-center gap-1.5 rounded-lg border px-2 py-1 text-[12.5px] ${
                          f.status === "error" ? "border-red-300 bg-red-50 text-red-700" : "border-slate-200 bg-slate-50 text-slate-700"
                        }`}
                      >
                        {f.status === "uploading" ? <Loader2 size={13} className="flex-none animate-spin" /> : <FileText size={13} className="flex-none" />}
                        <span className="min-w-0 truncate">{f.name}</span>
                        <span className="flex-none text-[11px] text-slate-500">{f.status === "error" ? "failed" : formatAttachmentSize(f.size)}</span>
                        <button onClick={() => setFiles((all) => all.filter((x) => x.key !== f.key))} aria-label={`Remove ${f.name}`} className="flex-none rounded p-0.5 hover:bg-slate-200">
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex items-center gap-1 border-t border-slate-100 px-2 py-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={CHAT_ATTACHMENT_ACCEPT}
                    className="hidden"
                    onChange={(e) => {
                      addFiles(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={files.length >= MAX_ATTACHMENTS_PER_MESSAGE}
                    aria-label="Attach files"
                    title="Attach files (images, PDF, Word, Excel · up to 10 MB each)"
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 disabled:opacity-50"
                  >
                    <Paperclip size={16} />
                  </button>
                  <button
                    ref={savedBtnRef}
                    onClick={() => setSavedOpen((v) => !v)}
                    disabled={mode !== "reply"}
                    aria-expanded={showSaved}
                    title="Saved replies (or type / in the box)"
                    className={`flex h-8 flex-none items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium hover:bg-slate-100 disabled:opacity-40 ${showSaved ? "bg-slate-100 text-slate-900" : "text-slate-600"}`}
                  >
                    <Zap size={15} /> Saved replies
                  </button>
                  <span className="min-w-0 flex-1" />
                  <button
                    onClick={() => void send()}
                    disabled={sending || uploadingFiles || (!draft.trim() && readyFiles.length === 0)}
                    title="Enter to send · Shift + Enter for a new line"
                    className="flex h-9 flex-none items-center gap-2 whitespace-nowrap rounded-lg bg-brand-primary px-4 text-[13.5px] font-semibold text-white shadow-sm transition-colors hover:bg-brand-primaryHover disabled:opacity-50"
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

      {/* ── Contact info ── (always on xl; slides over the thread below that) */}
      {activeId && profileOpen && (
        <div aria-hidden className="absolute inset-0 z-20 bg-slate-900/20" onMouseDown={() => setProfileOpen(false)} />
      )}
      {activeId && (
        <aside
          aria-label="Contact info"
          className={`${profileOpen ? "absolute inset-y-0 right-0 z-30 flex shadow-2xl" : "hidden"} w-80 max-w-full flex-none flex-col overflow-y-auto border-l border-slate-200 bg-slate-50`}
        >
          <div className="relative flex flex-col items-center gap-2.5 border-b border-slate-200 bg-white px-5 pb-5 pt-7 text-center">
            <button onClick={() => setProfileOpen(false)} aria-label="Close contact info" className="absolute left-3 top-3 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
              <X size={18} />
            </button>
            <ClientAvatar name={title} online={activeRow?.client_online} size="lg" />
            <div>
              <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
              {people[0]?.phone && <p className="text-[13px] text-slate-600">{people[0].phone}</p>}
              <p className={`text-xs ${activeRow?.client_online ? "font-medium text-emerald-700" : "text-slate-500"}`}>
                {activeRow?.client_online ? "Online in the portal now" : clientPresence || "Client"}
              </p>
            </div>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              {fileName} · {status === "open" ? "Open chat" : "Resolved"}
            </span>
          </div>

          <section className="m-3 mb-0 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm">
            <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {people.length > 1 ? `${people.length} people on this file` : "Contact"}
            </h3>
            <ul className="space-y-4">
              {(people.length > 0 ? people : [{ name: title, email: null, phone: null, primary: true }]).map((p) => (
                <li key={p.name + (p.email ?? "")} className="text-[13px]">
                  <div className="flex items-center gap-2.5">
                    <span className={`flex h-8 w-8 flex-none items-center justify-center rounded-full text-[11px] font-semibold ${tint(p.name)}`}>{initials(p.name)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-slate-900">{p.name}</span>
                      <span className="block text-xs text-slate-500">{p.primary ? "Primary client" : "Co-client"}</span>
                    </span>
                  </div>
                  {([
                    ["phone", p.phone, p.phone ? `tel:${p.phone.replace(/[^\d+]/g, "")}` : ""],
                    ["email", p.email, p.email ? `mailto:${p.email}` : ""],
                  ] as const).map(([kind, value, href]) =>
                    value ? (
                      <div key={kind} className="mt-1.5 flex items-center gap-2 pl-[42px]">
                        {kind === "phone" ? <Phone size={13} className="flex-none text-slate-400" /> : <Mail size={13} className="flex-none text-slate-400" />}
                        <a href={href} className="min-w-0 flex-1 truncate text-slate-700 hover:text-brand-primary hover:underline">{value}</a>
                        <button
                          onClick={() => {
                            void navigator.clipboard?.writeText(value).then(() => {
                              setCopied(value);
                              setTimeout(() => setCopied((c) => (c === value ? null : c)), 1500);
                            });
                          }}
                          aria-label={`Copy ${kind}`}
                          title={copied === value ? "Copied" : `Copy ${kind}`}
                          className="flex-none rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                        >
                          {copied === value ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                        </button>
                      </div>
                    ) : null,
                  )}
                </li>
              ))}
            </ul>
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

      {viewer && activeId && (
        <AttachmentViewer
          items={viewer.items}
          startIndex={viewer.index}
          hrefFor={(a, download) => attachmentHref(activeId, a, download)}
          onClose={() => setViewer(null)}
        />
      )}

      {deleting && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-slate-900/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && setConfirmDelete(null)}>
          <div role="alertdialog" aria-modal="true" aria-labelledby="del-title" className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
            <h2 id="del-title" className="text-base font-bold text-slate-900">Delete this {deleting.kind === "note" ? "note" : "message"}?</h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
              {deleting.kind === "note"
                ? "It will show as “This message was deleted” for staff."
                : "It will show as “This message was deleted” for everyone, including the client. An email already sent can’t be taken back."}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} autoFocus className="h-9 rounded-lg border border-slate-300 bg-white px-3.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button onClick={() => void removeMessage(deleting.id)} className="h-9 rounded-lg bg-red-600 px-3.5 text-[13px] font-semibold text-white hover:bg-red-700">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {manageOpen && (
        <SavedRepliesManager
          replies={savedReplies}
          editable={savedEditable}
          onClose={() => setManageOpen(false)}
          onChanged={loadSavedReplies}
          flash={flash}
        />
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
