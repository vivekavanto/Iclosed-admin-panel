"use client";

import React from "react";
import { useAuth } from "@/lib/AuthProvider";
import { moduleIds } from "@/lib/staffAccess";
import NotificationBell from "./NotificationBell";

// The thin bar across the top of every admin page.
//
// It exists for one reason: the notification bell used to sit in the dark
// sidebar rail, where staff didn't look and the unread dot went unnoticed for
// days. Top-right is where people expect notifications, so the bell lives here
// now and the rail is navigation only.
//
// Sticky rather than fixed, so it scrolls with the page container that
// ClientLayout already owns (`<main>` is the scroll root) instead of needing a
// second fixed element offset past the sidebar.
//
// The left padding on small screens clears Sidebar's fixed hamburger button,
// which is positioned at top-4 left-4.
const AppHeader: React.FC = () => {
  const { user } = useAuth();
  const showNotifications = moduleIds(user).some(id => ["dashboard", "deals", "leads", "tasks"].includes(id));
  return (
    <header className="sticky top-0 z-30 bg-white border-b border-slate-200">
      <div className="flex items-center justify-end gap-3 h-14 pl-16 pr-4 sm:pl-6 sm:pr-6">
        {showNotifications && <NotificationBell />}
      </div>
    </header>
  );
};

export default AppHeader;
