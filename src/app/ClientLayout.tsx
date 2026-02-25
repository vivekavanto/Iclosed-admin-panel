"use client";

import React from "react";
import Sidebar from "../components/Sidebar";
import SearchDrawer from "../components/SearchDrawer";
import { useNavigation } from "./providers";
import { useRouter } from "next/navigation";

export default function ClientLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isSearchOpen, openSearch, closeSearch } = useNavigation();
  const router = useRouter();

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
