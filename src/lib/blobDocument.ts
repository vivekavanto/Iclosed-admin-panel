// Server-side reader for a document that already lives in Vercel Blob.
//
// Why this exists: uploads used to stream the whole file through the API route
// (browser -> route -> put()), which Vercel caps at ~4.5 MB of request body
// (FUNCTION_PAYLOAD_TOO_LARGE). Documents are now uploaded straight from the
// browser to Blob (@vercel/blob/client), and the route only ever receives the
// resulting URL. Anything server-side that still needs the BYTES — Gemini
// identification — reads them back through here.
//
// Two invariants this module owns:
//   1. SSRF guard. These reads happen with a privileged store token, so the URL
//      must be a Vercel Blob URL and nothing else (same guard as the
//      /api/admin/documents/download proxy).
//   2. Size cap. head() is checked BEFORE the body is pulled, so an oversized
//      blob is rejected without ever being buffered into function memory.

import { get, head } from "@vercel/blob";
import { isBlobUrl, isPrivateBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { MAX_DOCUMENT_UPLOAD_BYTES } from "@/lib/uploadValidation";

export class BlobDocumentError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BlobDocumentError";
    this.status = status;
  }
}

export interface BlobDocumentMeta {
  url: string;
  pathname: string;
  size: number;
  contentType: string;
}

/**
 * Metadata for a stored blob. Throws BlobDocumentError (with an HTTP status the
 * caller can pass straight through) when the URL isn't a blob URL or the blob
 * doesn't exist.
 */
export async function readBlobMeta(url: string): Promise<BlobDocumentMeta> {
  if (!url || typeof url !== "string") {
    throw new BlobDocumentError("file_url is required.", 400);
  }
  if (!isBlobUrl(url)) {
    throw new BlobDocumentError("file_url is not a Vercel Blob URL.", 400);
  }

  let meta;
  try {
    meta = await head(url, { token: blobTokenForUrl(url) });
  } catch {
    // head() throws BlobNotFoundError for a URL that doesn't resolve, and an
    // access error for a store the token can't see. Both are "we can't use
    // this file" from the caller's point of view.
    throw new BlobDocumentError(
      "The uploaded file could not be found in storage. Please upload it again.",
      404,
    );
  }

  return {
    url,
    pathname: meta.pathname,
    size: meta.size,
    contentType: (meta.contentType || "application/octet-stream").toLowerCase(),
  };
}

/**
 * Read a stored blob's bytes, enforcing the document size cap first.
 *
 * `maxBytes` defaults to the 10 MB application ceiling — the same limit the
 * client-upload token enforces at write time, re-checked here so a blob written
 * by some other path can't push an oversized buffer through Gemini.
 */
export async function readBlobDocument(
  url: string,
  maxBytes: number = MAX_DOCUMENT_UPLOAD_BYTES,
): Promise<{ bytes: Buffer; meta: BlobDocumentMeta }> {
  const meta = await readBlobMeta(url);

  if (meta.size > maxBytes) {
    throw new BlobDocumentError(
      `File is too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB).`,
      413,
    );
  }

  // get() covers both stores: a private blob needs the private token and
  // access:"private"; a public one is readable with access:"public". Choosing by
  // the URL's own host (not the current NEXT_PUBLIC_PRIVATE_BLOB flag) keeps
  // reads working across a flag flip or rollback.
  const result = await get(url, {
    access: isPrivateBlobUrl(url) ? "private" : "public",
    token: blobTokenForUrl(url),
  });

  if (!result || !result.stream) {
    throw new BlobDocumentError(
      "The uploaded file could not be read from storage. Please upload it again.",
      404,
    );
  }

  const arrayBuffer = await new Response(
    result.stream as ReadableStream,
  ).arrayBuffer();

  return { bytes: Buffer.from(arrayBuffer), meta };
}
