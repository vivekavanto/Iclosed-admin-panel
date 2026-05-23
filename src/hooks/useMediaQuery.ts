"use client";

import { useState, useEffect } from "react";

/**
 * Hook to detect if a media query matches.
 * Returns false during SSR and initial hydration to prevent mismatches.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);

    setMatches(mediaQuery.matches);

    const handler = (event: MediaQueryListEvent) => {
      setMatches(event.matches);
    };

    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export function useIsLargeScreen(): boolean {
  return useMediaQuery("(min-width: 1024px)");
}
