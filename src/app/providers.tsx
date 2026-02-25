"use client";

import React, { createContext, useContext, useState, useCallback } from "react";

interface NavigationContextType {
  isSearchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
}

const NavigationContext = createContext<NavigationContextType>({
  isSearchOpen: false,
  openSearch: () => {},
  closeSearch: () => {},
});

export const useNavigation = () => useContext(NavigationContext);

export function NavigationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  const openSearch = useCallback(() => setIsSearchOpen(true), []);
  const closeSearch = useCallback(() => setIsSearchOpen(false), []);

  return (
    <NavigationContext.Provider
      value={{ isSearchOpen, openSearch, closeSearch }}
    >
      {children}
    </NavigationContext.Provider>
  );
}
