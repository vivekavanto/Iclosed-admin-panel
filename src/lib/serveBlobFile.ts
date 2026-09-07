// Serving one stored document to a browser, for the PUBLIC token routes.
//
// Two routes hand a document to someone with no session — the final reporting
// package (/api/final-report/download) and the clerk email's overflow links
// (/api/document-link/download) — and both need the same three decisions:
//
//   • PUBLIC BLOB → redirect. The file is already on a CDN; streaming 30 MB
//     back through a serverless function to hand over bytes the browser could
//     have fetched itself is pure cost. Vercel Blob serves inline by default,
//     which is what we want; its ?download=1 is added only for a save link.
//   • PRIVATE BLOB → proxy. The browser cannot read it on its own, so we fetch
//     it with the store token and stream it back.
//   • INLINE vs ATTACHMENT. A document should OPEN — a clerk clicking a link
//     wants to look at the ID, not to find it in their Downloads folder. Only
//     the explicit save link forces a download.
//
// Authorisation is NOT this helper's job: it serves whatever URL it is given.
// Every caller must have checked the URL against its token's own scope first.

import { NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { isPrivateBlobUrl, blobTokenForUrl } from "./blobPrivacy";
import { logger } from "./logger";

/**
 * Content types we are willing to render INLINE.
 *
 * An allowlist rather than a blocklist because the private branch streams from
 * OUR OWN origin: anything scriptable served inline there (HTML, SVG) would run
 * as us. uploadValidation.ts already refuses those on the way in — this is the
 * second lock, for rows that predate it. Anything not on the list is still
 * delivered, just as a download.
 */
export const INLINE_SAFE_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "text/plain",
]);

export type BlobServeResult =
  | { ok: true; response: Response }
  /** The blob is gone — the caller renders its own "no longer available" page. */
  | { ok: false; reason: "missing" }
  /** Something else went wrong; already logged. */
  | { ok: false; reason: "error" };

/** Strip what would break a Content-Disposition header. */
export function safeFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name || "").replace(/["\\r\n]/g, "").trim();
  return cleaned || fallback;
}

export async function serveBlobFile(opts: {
  fileUrl: string;
  /** Name the browser saves it under. */
  filename: string;
  /** true = save it, false/omitted = render it in the browser where we can. */
  forceDownload?: boolean;
  /** Prefix for log lines, e.g. "[FinalReport download]". */
  logLabel: string;
}): Promise<BlobServeResult> {
  const { fileUrl, filename, forceDownload = false, logLabel } = opts;
  if (!fileUrl) return { ok: false, reason: "missing" };

  if (!isPrivateBlobUrl(fileUrl)) {
    let direct: URL;
    try {
      direct = new URL(fileUrl);
    } catch {
      logger.error(`${logLabel} not a URL:`, fileUrl);
      return { ok: false, reason: "missing" };
    }
    if (forceDownload) direct.searchParams.set("download", "1");
    else direct.searchParams.delete("download");
    return { ok: true, response: NextResponse.redirect(direct.toString(), 302) };
  }

  try {
    const result = await get(fileUrl, {
      access: "private",
      token: blobTokenForUrl(fileUrl),
    });
    if (!result?.stream) return { ok: false, reason: "missing" };

    const headers = new Headers();
    const contentType = result.blob?.contentType || "application/octet-stream";
    headers.set("Content-Type", contentType);
    if (result.blob?.size != null) {
      headers.set("Content-Length", String(result.blob.size));
    }
    const inlineSafe = INLINE_SAFE_TYPES.has(
      contentType.split(";")[0].trim().toLowerCase(),
    );
    const disposition = !forceDownload && inlineSafe ? "inline" : "attachment";
    headers.set("Content-Disposition", `${disposition}; filename="${filename}"`);
    // Never let a browser render an unexpected type as something else.
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Cache-Control", "private, no-store");
    return { ok: true, response: new Response(result.stream as ReadableStream, { status: 200, headers }) };
  } catch (err) {
    logger.error(`${logLabel} blob read failed:`, err);
    return { ok: false, reason: "error" };
  }
}
