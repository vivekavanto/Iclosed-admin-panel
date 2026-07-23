// Central switch + helpers for private document storage (SEC-003 / CMP-001).
//
// Government IDs, APS agreements and other PII documents were uploaded to Vercel
// Blob with access:"public", so anyone holding the URL could open the file with
// no auth. This module lets us store them privately and serve them only through
// the auth-gated download proxy (/api/admin/documents/download).
//
// Rollout is env-gated so the admin and customer-portal deploys don't have to
// land atomically (mirrors the SERVICE_WEBHOOK_ENFORCE pattern in
// verifyServiceSignature.ts):
//   NEXT_PUBLIC_PRIVATE_BLOB unset / "false" -> new uploads stay PUBLIC exactly
//       as before. Ships dormant; nothing changes for either repo.
//   NEXT_PUBLIC_PRIVATE_BLOB = "true"         -> new uploads are PRIVATE and are
//       read back through the proxy. Flip this only once the customer portal
//       also serves private docs.
//
// Detection is by URL host: Vercel encodes the access level into the hostname as
//   https://<store>.<access>.blob.vercel-storage.com/<pathname>
// so every stored URL is self-describing — a `.private.` host means "proxy it",
// a `.public.` (or legacy) host means "serve directly". That is why NO database
// column or backfill is needed: old public rows keep working untouched, and only
// rows written after the flip carry a private URL.
//
// This module is isomorphic (no server-only imports) so it can be used from both
// client components and server routes.

export const PRIVATE_BLOB_ENABLED =
  process.env.NEXT_PUBLIC_PRIVATE_BLOB === "true";

// The access level to write NEW uploads with. Read this everywhere we call
// put()/upload() instead of hard-coding "public".
export const BLOB_ACCESS: "public" | "private" = PRIVATE_BLOB_ENABLED
  ? "private"
  : "public";

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

/** True for any Vercel Blob URL (public OR private). Used as an SSRF guard. */
export function isBlobUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** True only for a private Vercel Blob URL — one that must be proxied. */
export function isPrivateBlobUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.endsWith(`.private${BLOB_HOST_SUFFIX}`);
  } catch {
    return false;
  }
}

/**
 * The href a browser should use to open/download a stored document.
 *
 * Private blobs are routed through the same-origin, auth-gated proxy; public and
 * legacy blobs (and anything that isn't a blob URL, e.g. an already-relative
 * path) are returned unchanged. Passing a public URL is a no-op, so it is safe
 * to wrap EVERY document link with this — behaviour is identical until the flag
 * is flipped and new private URLs start appearing.
 */
export function docDownloadHref(url: string | null | undefined): string {
  if (!url) return "";
  if (isPrivateBlobUrl(url)) {
    return `/api/admin/documents/download?u=${encodeURIComponent(url)}`;
  }
  return url;
}

/**
 * `credentials` value for a browser fetch() of a document. Private docs go
 * through the same-origin proxy and need the session cookie ("include");
 * public blob URLs are cross-origin and must NOT send credentials ("omit"),
 * which is also the existing behaviour for every current fetch site.
 */
export function docFetchCredentials(
  url: string | null | undefined,
): RequestCredentials {
  return isPrivateBlobUrl(url) ? "include" : "omit";
}
