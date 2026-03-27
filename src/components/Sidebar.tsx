"use client";

import React, { useState } from "react";
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
  ListTodo,
  KeyRound,
} from "lucide-react";
import { NAV_ITEMS } from "../constants";
import { useAuth } from "@/lib/AuthProvider";

interface SidebarProps {
  onSearchClick?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const ROUTE_MAP: Record<string, string> = {
  dashboard: "/admin/dashboard",
  tasks: "/admin/tasks",
  deals: "/admin/deals",
  templates: "/admin/templates",
  "stage-templates": "/admin/templates",
  "task-templates": "/admin/templates/tasks",
  "email-templates": "/admin/templates/emails",
  leads: "/admin/leads",
  settings: "/admin/settings",
  "default-tasks": "/admin/settings/default-tasks",
};

const iconMap: Record<string, React.ReactNode> = {
  LayoutDashboard: <LayoutDashboard size={20} />,
  Search: <Search size={20} />,
  ClipboardCheck: <ClipboardCheck size={20} />,
  ListTodo: <ListTodo size={20} />,
  Files: <Files size={20} />,
  FileStack: <FileStack size={20} />,
  Users: <Users size={20} />,
  Settings: <Settings size={20} />,
  Briefcase: <Briefcase size={20} />,
  FileText: <FileText size={20} />,
};

const Sidebar: React.FC<SidebarProps> = ({ onSearchClick = () => {}, collapsed = false, onToggleCollapse }) => {
  const pathname = usePathname();
  const { user, signOut } = useAuth();

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

  return (
    <div
      className={`${collapsed ? "w-[72px]" : "w-64"} bg-slate-900 text-slate-300 flex flex-col h-screen fixed left-0 top-0 border-r border-slate-800 shadow-xl z-20 transition-all duration-300`}
    >
      {/* Logo & Toggle */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-slate-800">
        {!collapsed && (
          <Image src="/logo.png" alt="iClosed" width={90} height={24} className="select-none invert brightness-0 invert" style={{ filter: "brightness(0) invert(1)" }} />
        )}
        <button
          onClick={() => onToggleCollapse?.()}
          className={`p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors ${collapsed ? "mx-auto" : ""}`}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active =
            isActive(item.id) || (item.id === "templates" && isTemplateActive);
          const hasChildren = item.children && item.children.length > 0;
          const route = ROUTE_MAP[item.id] || "/";

          if (item.id === "search") {
            return (
              <div key={item.id}>
                <button
                  onClick={onSearchClick}
                  title={collapsed ? item.label : undefined}
                  className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 hover:bg-slate-800 hover:text-white ${collapsed ? "" : "px-4 !justify-start gap-3"}`}
                >
                  {iconMap[item.icon]}
                  {!collapsed && <span className="font-medium text-sm">{item.label}</span>}
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
                    if (collapsed) {
                      onToggleCollapse?.();
                      if (!openMenus.has(item.id)) toggleMenu(item.id);
                    } else {
                      toggleMenu(item.id);
                    }
                  }}
                  title={collapsed ? item.label : undefined}
                  className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 ${collapsed ? "" : "px-4 !justify-between"} ${
                    active
                      ? "bg-brand-primary text-white shadow-md shadow-brand-primary/20"
                      : "hover:bg-slate-800 hover:text-white"
                  }`}
                >
                  <div className={`flex items-center ${collapsed ? "" : "gap-3"}`}>
                    {iconMap[item.icon]}
                    {!collapsed && <span className="font-medium text-sm">{item.label}</span>}
                  </div>
                  {!collapsed && (
                    <ChevronDown
                      size={14}
                      className={`transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                  )}
                </button>
                {isOpen && !collapsed && (
                  <div className="ml-9 space-y-1 py-1">
                    {item.children!.map((child) => {
                      const childRoute = ROUTE_MAP[child.id] || "/";
                      const childActive = pathname === childRoute;
                      return (
                        <Link
                          key={child.id}
                          href={childRoute}
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

          return (
            <div key={item.id}>
              <Link
                href={route}
                title={collapsed ? item.label : undefined}
                className={`w-full flex items-center justify-center py-2.5 rounded-lg transition-all duration-200 ${collapsed ? "" : "px-4 !justify-start gap-3"} ${
                  active
                    ? "bg-brand-primary text-white shadow-md shadow-brand-primary/20"
                    : "hover:bg-slate-800 hover:text-white"
                }`}
              >
                {iconMap[item.icon]}
                {!collapsed && <span className="font-medium text-sm">{item.label}</span>}
              </Link>
            </div>
          );
        })}
      </nav>

      {/* User Section */}
      <div className="p-3 border-t border-slate-800 space-y-2">
        {collapsed ? (
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
    </div>
  );
};

export default Sidebar;
