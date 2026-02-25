"use client";

import React from "react";
import Link from "next/link";
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
  ClipboardCheck,
  ListTodo,
} from "lucide-react";
import { NAV_ITEMS, CURRENT_USER } from "../constants";

interface SidebarProps {
  onSearchClick?: () => void;
}

const ROUTE_MAP: Record<string, string> = {
  dashboard: "/",
  intake: "/intake",
  tasks: "/tasks",
  deals: "/deals",
  templates: "/templates",
  "stage-templates": "/templates",
  "task-templates": "/templates/tasks",
  "email-templates": "/templates/emails",
  leads: "/leads",
  settings: "/settings",
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

const Sidebar: React.FC<SidebarProps> = ({ onSearchClick = () => {} }) => {
  const pathname = usePathname();

  const isActive = (itemId: string) => {
    const route = ROUTE_MAP[itemId];
    if (!route) return false;
    if (route === "/") return pathname === "/";
    return pathname === route || pathname.startsWith(route + "/");
  };

  const isTemplateActive = pathname.startsWith("/templates");

  return (
    <div className="w-64 bg-slate-900 text-slate-300 flex flex-col h-screen fixed left-0 top-0 border-r border-slate-800 shadow-xl z-20">
      <div className="p-6 flex items-center space-x-3 text-white border-b border-slate-800">
        <div className="flex items-baseline select-none">
          <span className="font-serif italic font-medium text-2xl tracking-tight text-brand-primary mr-[1px]">
            i
          </span>
          <span className="font-sans font-bold text-2xl tracking-tight text-white">
            Closed
          </span>
        </div>
      </div>
      <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const active =
            isActive(item.id) || (item.id === "templates" && isTemplateActive);
          const hasChildren = item.children && item.children.length > 0;
          const route = ROUTE_MAP[item.id] || "/";

          if (item.id === "search") {
            return (
              <div key={item.id} className="space-y-1">
                <button
                  onClick={onSearchClick}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-lg transition-all duration-200 hover:bg-slate-800 hover:text-white"
                >
                  <div className="flex items-center space-x-3">
                    {iconMap[item.icon]}
                    <span className="font-medium">{item.label}</span>
                  </div>
                </button>
              </div>
            );
          }

          return (
            <div key={item.id} className="space-y-1">
              <Link
                href={route}
                className={`w-full flex items-center justify-between px-4 py-3 rounded-lg transition-all duration-200 ${
                  active
                    ? "bg-brand-primary text-white shadow-md shadow-brand-primary/20"
                    : "hover:bg-slate-800 hover:text-white"
                }`}
              >
                <div className="flex items-center space-x-3">
                  {iconMap[item.icon]}
                  <span className="font-medium">{item.label}</span>
                </div>
                {hasChildren && (
                  <ChevronDown
                    size={14}
                    className={`transition-transform duration-200 ${active ? "rotate-180" : ""}`}
                  />
                )}
              </Link>
              {hasChildren && active && (
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
        })}
      </nav>
      <div className="p-4 border-t border-slate-800">
        <div className="flex items-center space-x-3 px-4 py-3 rounded-lg bg-slate-800/50 hover:bg-slate-800 transition-colors cursor-pointer">
          <img
            src={CURRENT_USER.avatarUrl}
            alt={CURRENT_USER.name}
            className="w-10 h-10 rounded-full border-2 border-slate-600"
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate">
              {CURRENT_USER.name}
            </p>
            <p className="text-xs text-slate-500 truncate">
              {CURRENT_USER.role}
            </p>
          </div>
          <button className="text-slate-400 hover:text-white">
            <LogOut size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default Sidebar;
