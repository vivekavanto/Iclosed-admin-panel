"use client";

import React, { useState } from "react";
import Sidebar from "../components/Sidebar";
import AppHeader from "../components/AppHeader";
import SearchDrawer from "../components/SearchDrawer";
import { useNavigation } from "./providers";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { isPublicPath } from "@/lib/publicRoutes";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isSearchOpen, openSearch, closeSearch } = useNavigation();
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // The public surface renders bare: no sidebar, no header, and — critically —
  // no auth gate of any kind. This is checked BEFORE the loading spinner so a
  // visitor with no session never watches getSession() resolve before seeing a
  // page that was never going to need it.
  if (isPublicPath(pathname)) {
    return <>{children}</>;
  }

  // Show loading spinner while checking auth
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-red-500" />
      </div>
    );
  }

  // Login page — no sidebar
  if (pathname === "/admin/login") {
    return <>{children}</>;
  }

  // Not authenticated — don't render anything (redirect happens in AuthProvider)
  if (!user) {
    return null;
  }

  // The All files dashboard has a wide multi-column table, so it renders
  // edge-to-edge (no max-width cap / centering) to fill the page and avoid
  // horizontal scrolling. Other admin pages keep the centered max-w-7xl column.
  const isFullWidth = pathname === "/admin/deals";

  return (
    <div
      className="bg-slate-50 min-h-screen font-sans text-slate-900 flex"
      // Exposed so fixed-position overlays (Add Task / Add Stage modals, etc.)
      // can offset themselves past the sidebar instead of covering it.
      style={{ ["--sidebar-w" as any]: sidebarCollapsed ? "72px" : "256px" }}
    >
      <Sidebar
        onSearchClick={openSearch}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <SearchDrawer
        isOpen={isSearchOpen}
        onClose={closeSearch}
        onNavigateToDeal={(id) => {
          router.push(`/admin/deals/${id}`);
          closeSearch();
        }}
      />
      {/* `<main>` is the scroll root, so AppHeader lives INSIDE it and sticks to
          the top as the page scrolls. Padding moved onto the inner wrapper so
          the header can span edge-to-edge under it. */}
      <main
        className={`ml-0 ${sidebarCollapsed ? "md:ml-[72px]" : "md:ml-64"} flex-1 h-screen overflow-y-auto transition-all duration-300`}
      >
        <AppHeader />
        <div className="p-4 sm:p-6 md:p-8">
          <div className={`${isFullWidth ? "w-full" : "max-w-7xl mx-auto"}`}>{children}</div>
        </div>
      </main>
    </div>
  );
}
