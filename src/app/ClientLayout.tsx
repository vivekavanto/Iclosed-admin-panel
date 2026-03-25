"use client";

import React from "react";
import Sidebar from "../components/Sidebar";
import SearchDrawer from "../components/SearchDrawer";
import { useNavigation } from "./providers";
import { useRouter, usePathname } from "next/navigation";
import { useAuth } from "@/lib/AuthProvider";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isSearchOpen, openSearch, closeSearch } = useNavigation();
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useAuth();

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

  return (
    <div className="bg-slate-50 min-h-screen font-sans text-slate-900 flex">
      <Sidebar onSearchClick={openSearch} />
      <SearchDrawer
        isOpen={isSearchOpen}
        onClose={closeSearch}
        onNavigateToDeal={(id) => {
          router.push(`/deals/${id}`);
          closeSearch();
        }}
      />
      <main className="ml-64 flex-1 p-8 h-screen overflow-y-auto">
        <div className="max-w-7xl mx-auto h-full">{children}</div>
      </main>
    </div>
  );
}
