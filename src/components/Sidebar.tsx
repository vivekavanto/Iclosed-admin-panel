"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Wallet,
  Briefcase,
  Users,
  FileText,
  Settings,
  LogOut,
  Search,
  Files,
  FileStack,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Calculator,
  ListTodo,
  Check,
  KeyRound,
  UserCog,
  Handshake,
  Menu,
  MessageSquare,
  Newspaper,
  X,
} from "lucide-react";
import { hasModule, isOwner } from "@/lib/staffAccess";
import { NAV_ITEMS } from "../constants";
import { useAuth } from "@/lib/AuthProvider";
import { NEW_LEADS_SEEN_EVENT } from "@/lib/newLeadBadge";
import { useChatChannel } from "@/hooks/useChatChannel";
import { useStaffPresence, type Availability } from "@/hooks/useStaffPresence";

// Online / Away menu on the user avatar (design: "Agent inbox" rail avatar).
// Only for staff with the Messages module, and only once the presence
// migration has run (`me` stays null until the server confirms the table).
function AvailabilityMenu({
  me,
  onPick,
  label,
  children,
}: {
  me: Availability | null;
  onPick: (m: "online" | "away") => void;
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!me) return <>{children}</>;
  const state = me.status === "online" ? "Online" : "Away";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}. Your availability: ${state}`}
        title={`Availability: ${state}`}
        className="relative block rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary/60"
      >
        {children}
        <span
          aria-hidden="true"
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-slate-900 ${
            me.status === "online" ? "bg-emerald-500" : "bg-amber-500"
          }`}
        />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-50 mb-2 w-64 rounded-xl border border-slate-200 bg-white p-1.5 text-slate-900 shadow-xl">
          <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Your availability</p>
          {(["online", "away"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={me.manual === m}
              onClick={() => {
                setOpen(false);
                onPick(m);
              }}
              className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-slate-50"
            >
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${m === "online" ? "bg-emerald-500" : "bg-amber-500"}`} />
              <span className="flex-1">{m === "online" ? "Online" : "Away"}</span>
              {me.manual === m && <Check size={16} />}
            </button>
          ))}
          <p className="mx-2.5 mb-2 mt-1 text-xs leading-snug text-slate-600">
            When nobody is online, clients see that the team is away and that we&apos;ll reply by email.
          </p>
          {me.manual === "online" && me.status === "away" && (
            <p className="mx-2.5 mb-2 text-xs leading-snug text-amber-700">Set to Away automatically after 15 minutes without activity.</p>
          )}
        </div>
      )}
    </div>
  );
}

// How often the sidebar asks whether a new lead is waiting. Intake is a
// human-paced event and the endpoint reads ids only, so a minute is plenty —
// it matches the header bell's cadence so the two dots light up together.
const NEW_LEAD_POLL_MS = 60_000;

interface SidebarProps {
  onSearchClick?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const ROUTE_MAP: Record<string, string> = {
  "legal-assistant": "/admin/legal-assistant",
  access: "/admin/access",
  finance: "/admin/finance",
  dashboard: "/admin/dashboard",
  tasks: "/admin/tasks",
  deals: "/admin/deals",
  // Outside /admin on purpose: the calculator is ONE page, shared with clerks
  // who have no login (src/lib/publicRoutes.ts). Staff reach it from here and
  // get it inside the usual shell; a clerk opens the same URL and gets the page
  // on its own.
  calculator: "/closing-cost-calculator",
  templates: "/admin/templates",
  "stage-templates": "/admin/templates",
  "task-templates": "/admin/templates/tasks",
  "email-templates": "/admin/templates/emails",
  leads: "/admin/leads",
  messages: "/admin/messages",
  blogs: "/admin/blogs",
  partners: "/admin/partners",
  "agent-portal": "/admin/agent-portal",
  staff: "/admin/users",
  settings: "/admin/settings",
  "default-tasks": "/admin/settings/default-tasks",
  "closing-cost-settings": "/admin/settings/closing-costs",
  "account-settings": "/admin/account-settings",
  // Signing appointments: goes straight to the appointments list (lawyers/hours
  // and general settings live under Settings, where their own links already are).
  "signing-appointments": "/admin/settings/signing/appointments",
  "signing-lawyers-settings": "/admin/settings/signing/lawyers",
  "signing-general-settings": "/admin/settings/signing/general",
  "signing-appointments-list": "/admin/settings/signing/appointments",
};

const iconMap: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard size={20} />,
  Wallet: <Wallet size={20} />,
  Search: <Search size={20} />,
  ClipboardCheck: <ClipboardCheck size={20} />,
  ListTodo: <ListTodo size={20} />,
  Files: <Files size={20} />,
  Calculator: <Calculator size={20} />,
  FileStack: <FileStack size={20} />,
  Users: <Users size={20} />,
  MessageSquare: <MessageSquare size={20} />,
  UserCog: <UserCog size={20} />,
  Handshake: <Handshake size={20} />,
  Newspaper: <Newspaper size={20} />,
  Settings: <Settings size={20} />,
  Briefcase: <Briefcase size={20} />,
  FileText: <FileText size={20} />,
};

const Sidebar: React.FC<SidebarProps> = ({ onSearchClick = () => {}, collapsed = false, onToggleCollapse }) => {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Yellow dot on the Leads button: lit while this admin has an unseen
  // lead.created notification, empty otherwise. Per-admin, so it doesn't go
  // dark for everyone the moment one person opens the list.
  const [newLeadCount, setNewLeadCount] = useState(0);

  const loadNewLeadCount = useCallback(async () => {
    if (!hasModule(user, "leads")) return;
    try {
      const res = await fetch("/api/admin/notifications/new-leads");
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) setNewLeadCount(Number(data.count) || 0);
    } catch {
      // Leave the last known value alone — a transient blip shouldn't blink
      // the dot off and make staff think they had already looked.
    }
  }, [user]);

  // Unread client chat messages -> count badge on the Messages button. Polled,
  // and refreshed the moment the inbox channel pings when realtime is on.
  const chatOn = hasModule(user, "messages");
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [inboxChannel, setInboxChannel] = useState<string | null>(null);
  const loadUnread = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/messages?summary=1");
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) {
        setUnreadMessages(Number(data.unread) || 0);
        setInboxChannel(data.realtime?.inbox ?? null);
      }
    } catch {
      // Keep the last known count.
    }
  }, []);
  const unreadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { connected: inboxLive } = useChatChannel(
    chatOn ? inboxChannel : null,
    (event) => {
      if (event !== "changed") return;
      // Coalesce a burst of pings (message + read + assign) into one fetch.
      if (unreadTimer.current) clearTimeout(unreadTimer.current);
      unreadTimer.current = setTimeout(() => void loadUnread(), 300);
    },
    () => void loadUnread(),
  );
  useEffect(() => {
    if (!chatOn) return;
    const initial = setTimeout(loadUnread, 0);
    const timer = setInterval(loadUnread, inboxLive ? 60_000 : 20_000);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
    };
  }, [pathname, chatOn, inboxLive, loadUnread]);

  const { me: availability, setManual: setAvailability } = useStaffPresence(chatOn);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (!cancelled) loadNewLeadCount();
    };
    // Deferred rather than run inline so mounting the sidebar doesn't set
    // state synchronously inside the effect body.
    const initial = setTimeout(tick, 0);
    const timer = setInterval(tick, NEW_LEAD_POLL_MS);
    // The leads list clears the badge server-side and then fires this, so the
    // dot goes out on arrival instead of lingering until the next poll.
    const onSeen = () => setNewLeadCount(0);
    window.addEventListener(NEW_LEADS_SEEN_EVENT, onSeen);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener(NEW_LEADS_SEEN_EVENT, onSeen);
    };
  }, [loadNewLeadCount]);

  const isActive = (itemId: string) => {
    const route = ROUTE_MAP[itemId];
    if (!route) return false;
    if (route === "/") return pathname === "/";
    // "Signing Appointments" is its own top-level nav item even though its
    // page lives under /admin/settings/signing/appointments — without this
    // guard that prefix also matches the "settings" route below, lighting up
    // both pills at once.
    if (itemId === "settings" && pathname.startsWith(ROUTE_MAP["signing-appointments"])) {
      return false;
    }
    return pathname === route || pathname.startsWith(route + "/");
  };

  const isTemplateActive = pathname.startsWith("/admin/templates");

  const [openMenus, setOpenMenus] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (pathname.startsWith("/admin/templates")) initial.add("templates");
    if (pathname.startsWith("/admin/settings") && !pathname.startsWith(ROUTE_MAP["signing-appointments"])) {
      initial.add("settings");
    }
    if (pathname.startsWith("/admin/account-settings")) initial.add("settings");
    return initial;
  });

  const toggleMenu = (id: string) => {
    setOpenMenus((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sidebarContent = (isMobile: boolean) => {
    const showLabels = isMobile || !collapsed;
    return (
      <>
        {/* Logo & Toggle */}
        <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
          {showLabels && (
            <Image src="/logo.png" alt="iClosed" width={90} height={24} className="select-none invert brightness-0 invert" style={{ filter: "brightness(0) invert(1)" }} />
          )}
          {isMobile ? (
            <button onClick={() => setMobileOpen(false)} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
              <X size={18} />
            </button>
          ) : (
            <button
              onClick={() => onToggleCollapse?.()}
              className={`p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors ${collapsed ? "mx-auto" : ""}`}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
            </button>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 min-h-0 px-2 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.filter((item) => hasModule(user, item.id)).map((item) => {
            const active =
              isActive(item.id) ||
              (item.id === "templates" && isTemplateActive);
            const hasChildren = item.children && item.children.length > 0;
            const route = ROUTE_MAP[item.id] || "/";

            if (item.id === "search") {
              return (
                <div key={item.id}>
                  <button
                    onClick={() => { onSearchClick(); if (isMobile) setMobileOpen(false); }}
                    title={!showLabels ? item.label : undefined}
                    className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 hover:bg-slate-800 hover:text-white ${showLabels ? "px-4 !justify-start gap-3" : ""}`}
                  >
                    {iconMap[item.icon]}
                    {showLabels && <span className="font-medium text-sm">{item.label}</span>}
                  </button>
                </div>
              );
            }

            const isOpen = openMenus.has(item.id);

            if (hasChildren) {
              return (
                <div key={item.id}>
                  <button
                    onClick={() => {
                      if (!showLabels) {
                        onToggleCollapse?.();
                        if (!openMenus.has(item.id)) toggleMenu(item.id);
                      } else {
                        toggleMenu(item.id);
                      }
                    }}
                    title={!showLabels ? item.label : undefined}
                    className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 ${showLabels ? "px-4 !justify-between" : ""} ${
                      active
                        ? "bg-brand-primary text-white shadow-md shadow-brand-primary/20"
                        : "hover:bg-slate-800 hover:text-white"
                    }`}
                  >
                    <div className={`flex items-center ${showLabels ? "gap-3" : ""}`}>
                      {iconMap[item.icon]}
                      {showLabels && <span className="font-medium text-sm">{item.label}</span>}
                    </div>
                    {showLabels && (
                      <ChevronDown
                        size={14}
                        className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                      />
                    )}
                  </button>
                  {isOpen && showLabels && (
                    <div className="ml-9 space-y-1 py-1">
                      {item.children!.map((child) => {
                        const childRoute = ROUTE_MAP[child.id] || "/";
                        const childActive = pathname === childRoute;
                        return (
                          <Link
                            key={child.id}
                            href={childRoute}
                            onClick={() => { if (isMobile) setMobileOpen(false); }}
                            className={`block w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                              childActive
                                ? "text-white bg-slate-800 font-bold"
                                : "text-slate-400 hover:text-white hover:bg-slate-800/50"
                            }`}
                          >
                            {child.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            }

            // Only Leads carries a badge today. It sits on the <Link> rather
            // than on the icon so it pins to the button's corner whether the
            // rail is expanded or collapsed to icons.
            const showNewLeadDot = item.id === "leads" && newLeadCount > 0;

            return (
              <div key={item.id}>
                <Link
                  href={route}
                  onClick={() => { if (isMobile) setMobileOpen(false); }}
                  title={!showLabels ? item.label : undefined}
                  className={`relative w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 ${showLabels ? "px-4 !justify-start gap-3" : ""} ${
                    active
                      ? "bg-brand-primary text-white shadow-md shadow-brand-primary/20"
                      : "hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  {iconMap[item.icon]}
                  {showLabels && <span className="font-medium text-sm">{item.label}</span>}
                  {item.id === "messages" && unreadMessages > 0 && (
                    <span
                      className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-bold leading-none tabular-nums ${
                        // On the red active pill a red badge disappears and its dark
                        // ring reads as a black circle, so invert it there.
                        active
                          ? "bg-white text-brand-primary"
                          : "bg-brand-primary text-white ring-2 ring-slate-900"
                      } ${showLabels ? "ml-auto" : "absolute -top-1 -right-1"}`}
                    >
                      {unreadMessages}
                    </span>
                  )}
                  {showNewLeadDot && (
                    <>
                      {/* Amber, not the brand red the bell uses: this says
                          "something new to look at", not "something is wrong".
                          The ring keeps it readable against both the dark rail
                          and the red active pill. */}
                      <span
                        aria-hidden="true"
                        className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-amber-400 ring-2 ring-slate-900"
                      />
                      <span className="sr-only">
                        {newLeadCount} new lead{newLeadCount === 1 ? "" : "s"}
                      </span>
                    </>
                  )}
                </Link>
              </div>
            );
          })}
        </nav>

        {/* User Section */}
        <div className="p-3 border-t border-slate-800 space-y-2">
          {!showLabels ? (
            <>
              <div className="flex justify-center">
                <AvailabilityMenu me={chatOn ? availability : null} onPick={(m) => void setAvailability(m)} label={user?.email ?? "Account"}>
                  <div className="w-9 h-9 rounded-full border-2 border-slate-600 bg-slate-700 flex items-center justify-center text-white font-semibold text-xs">
                    {user?.email?.charAt(0).toUpperCase() ?? "A"}
                  </div>
                </AvailabilityMenu>
              </div>
              <div className="flex flex-col items-center gap-1">
                <Link
                  href="/admin/change-password"
                  title="Change Password"
                  className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <KeyRound size={16} />
                </Link>
                <button
                  onClick={signOut}
                  title="Logout"
                  className="p-2 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
                >
                  <LogOut size={16} />
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center space-x-3 px-3 py-2.5 rounded-lg bg-slate-800/50">
                <AvailabilityMenu me={chatOn ? availability : null} onPick={(m) => void setAvailability(m)} label={user?.email ?? "Account"}>
                  <div className="w-9 h-9 rounded-full border-2 border-slate-600 bg-slate-700 flex items-center justify-center text-white font-semibold text-sm shrink-0">
                    {user?.email?.charAt(0).toUpperCase() ?? "A"}
                  </div>
                </AvailabilityMenu>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {user?.email ?? "Admin"}
                  </p>
                  <p className="text-xs text-slate-500 truncate capitalize">
                    {isOwner(user) ? "Owner" : "Staff"}
                    {chatOn && availability && (
                      <span className="normal-case"> · {availability.status === "online" ? "Online" : "Away"}</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 px-1">
                <Link
                  href="/admin/change-password"
                  onClick={() => { if (isMobile) setMobileOpen(false); }}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <KeyRound size={14} />
                  Change Password
                </Link>
                <button
                  onClick={signOut}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
                >
                  <LogOut size={14} />
                  Logout
                </button>
              </div>
            </>
          )}
        </div>
      </>
    );
  };

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="md:hidden fixed top-4 left-4 z-30 p-2 rounded-lg bg-slate-900 text-white shadow-lg"
        aria-label="Open menu"
      >
        <Menu size={20} />
      </button>

      {/* Mobile overlay + drawer */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute left-0 top-0 h-full w-64 bg-slate-900 text-slate-300 flex flex-col shadow-2xl animate-in slide-in-from-left duration-200">
            {sidebarContent(true)}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div
        className={`hidden md:flex ${collapsed ? "w-[72px]" : "w-64"} bg-slate-900 text-slate-300 flex-col h-screen fixed left-0 top-0 border-r border-slate-800 shadow-xl z-20 transition-all duration-300`}
      >
        {sidebarContent(false)}
      </div>
    </>
  );
};

export default Sidebar;
