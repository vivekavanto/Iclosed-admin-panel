"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
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
  KeyRound,
  UserCog,
  Handshake,
  Menu,
  X,
} from "lucide-react";
import { NAV_ITEMS } from "../constants";
import { useAuth } from "@/lib/AuthProvider";
import { NEW_LEADS_SEEN_EVENT } from "@/lib/newLeadBadge";

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
  partners: "/admin/partners",
  staff: "/admin/users",
  settings: "/admin/settings",
  "default-tasks": "/admin/settings/default-tasks",
  "closing-cost-settings": "/admin/settings/closing-costs",
  "account-settings": "/admin/account-settings",
};

const iconMap: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard size={20} />,
  Search: <Search size={20} />,
  ClipboardCheck: <ClipboardCheck size={20} />,
  ListTodo: <ListTodo size={20} />,
  Files: <Files size={20} />,
  Calculator: <Calculator size={20} />,
  FileStack: <FileStack size={20} />,
  Users: <Users size={20} />,
  UserCog: <UserCog size={20} />,
  Handshake: <Handshake size={20} />,
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
    try {
      const res = await fetch("/api/admin/notifications/new-leads");
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) setNewLeadCount(Number(data.count) || 0);
    } catch {
      // Leave the last known value alone — a transient blip shouldn't blink
      // the dot off and make staff think they had already looked.
    }
  }, []);

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
    return pathname === route || pathname.startsWith(route + "/");
  };

  const isTemplateActive = pathname.startsWith("/admin/templates");

  const [openMenus, setOpenMenus] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (pathname.startsWith("/admin/templates")) initial.add("templates");
    if (pathname.startsWith("/admin/settings")) initial.add("settings");
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
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
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
                <div className="w-9 h-9 rounded-full border-2 border-slate-600 bg-slate-700 flex items-center justify-center text-white font-semibold text-xs">
                  {user?.email?.charAt(0).toUpperCase() ?? "A"}
                </div>
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
                <div className="w-9 h-9 rounded-full border-2 border-slate-600 bg-slate-700 flex items-center justify-center text-white font-semibold text-sm shrink-0">
                  {user?.email?.charAt(0).toUpperCase() ?? "A"}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {user?.email ?? "Admin"}
                  </p>
                  <p className="text-xs text-slate-500 truncate capitalize">
                    {(user?.user_metadata?.role as string) ?? "Admin"}
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
