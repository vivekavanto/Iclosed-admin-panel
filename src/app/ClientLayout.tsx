"use client";

import React, { useState } from "react";
import Sidebar from "../components/Sidebar";
import AppHeader from "../components/AppHeader";
import SearchDrawer from "../components/SearchDrawer";
import { useNavigation } from "./providers";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";
import { isPublicRoute } from "@/lib/publicRoutes";

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

  // A public page (the shared closing-cost calculator) is the one place where
  // BOTH kinds of visitor arrive at the same URL, so the shell follows the
  // visitor rather than the route: a signed-in admin gets the sidebar and header
  // they get everywhere else, and a clerk with no session gets the page on its
  // own. Only the anonymous case short-circuits here — the admin case falls
  // through to the normal shell below.
  //
  // `loading` is not waited on: the session check reads local storage, so an
  // admin sees the shell in the same frame, while a clerk is never held behind a
  // spinner for a session they will never have.
  if (isPublicRoute(pathname) && !user) {
    // Same page surface as the shell below, minus the chrome — otherwise the
    // calculator would sit on bare white for a clerk and on slate for staff.
    return (
      <div className="bg-slate-50 min-h-screen font-sans text-slate-900">
        {children}
      </div>
    );
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
      // --sidebar-w: so fixed-position overlays (Add Task / Add Stage modals,
      //   etc.) can offset themselves past the sidebar instead of covering it.
      // --app-header-h: AppHeader's height, set ONLY here. A sticky element
      //   inside a page reads it to sit below the header, and falls back to 0
      //   on a page rendered without this shell — which is how the shared
      //   calculator's action bar lands correctly for both staff and clerks.
      style={
        {
          "--sidebar-w": sidebarCollapsed ? "72px" : "256px",
          "--app-header-h": "56px",
        } as React.CSSProperties
      }
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
