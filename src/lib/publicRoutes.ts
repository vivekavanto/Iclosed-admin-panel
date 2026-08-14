// Pages in this app that are served WITHOUT an admin session.
//
// Everything else is staff-only, enforced in two places that both have to know
// about this list:
//   • src/middleware.ts — only matches /admin/* and /api/admin/*, so a public
//     path is outside the gate by construction and needs no entry here.
//   • AuthProvider + ClientLayout — these wrap EVERY page from the root layout,
//     and would otherwise bounce an anonymous visitor to /admin/login and render
//     the page inside the staff sidebar. That is what this list is for.
//
// Keep it short. A path added here is readable by anyone on the internet, so
// each one needs its own answer to "what can a stranger do with this?".

export const PUBLIC_ROUTES = ["/closing-cost-calculator"] as const;

/** True for a public page (exact match, or anything nested under it). */
export function isPublicRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}
