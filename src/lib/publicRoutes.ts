// Paths in this app that are reachable WITHOUT an admin session.
//
// Two independent gates have to agree about this list, which is why it lives in
// one module rather than being spelled twice:
//
//   • src/middleware.ts never runs on them — its matcher only covers
//     /admin/* and /api/admin/*, so a path outside those prefixes is already
//     public server-side. Nothing here loosens that gate.
//   • The BROWSER shell, though, is not path-scoped: AuthProvider redirects any
//     unauthenticated visitor to /admin/login and ClientLayout renders `null`
//     for them. Without an exemption a genuinely public page would bounce to a
//     login screen it never needed.
//
// So this list is what tells the client-side shell "stop guarding here". Keep it
// to paths that are DESIGNED to be public: adding one silently un-chromes and
// un-guards that page in the browser.

/**
 * The public surface, as path prefixes.
 *
 * `/calculator` — the shareable closing-cost estimator. No login, no file, no
 * data read or written on anyone's behalf: a visitor types their own numbers and
 * gets the firm's published fee schedule applied to them.
 */
export const PUBLIC_PATH_PREFIXES = ["/calculator"] as const;

/** True when `pathname` is part of the public, no-login surface. */
export function isPublicPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return PUBLIC_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
