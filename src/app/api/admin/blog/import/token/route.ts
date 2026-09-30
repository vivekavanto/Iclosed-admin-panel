import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { blobToken } from "@/lib/blobPrivacy";
import { MAX_IMPORT_BYTES } from "@/lib/blogImport";

/**
 * POST /api/admin/blog/import/token
 *
 * Issues a short-lived upload token so the admin browser can `upload()` a blog
 * import document DIRECTLY to Vercel Blob, instead of streaming it through
 * POST /api/admin/blog/import. Same reason every other large-document upload
 * in this app does this (see uploadblobstorage/token/route.ts): Vercel caps a
 * serverless function's request body at ~4.5 MB, so a route reading the bytes
 * itself cannot honor MAX_IMPORT_BYTES (20 MB). With a client upload the bytes
 * never touch a function until the import route reads them back from Blob.
 *
 * Content-type is deliberately generous: browsers disagree about the MIME
 * type for .md/.docx (see blogImport.ts's importKindFor comment) and Vercel
 * Blob only supports exact types or a single-level prefix wildcard (e.g.
 * "text" + slash + star) — a bare double-star wildcard is matched literally
 * and rejects everything. The real validation is the EXTENSION check the
 * import route already does once the file is read back; this list only has
 * to be wide enough that a real upload never gets turned away by the token
 * itself. Auth is src/middleware.ts, which already requires an authenticated
 * admin for every /api/admin/* route before this handler runs.
 */
const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/html",
  // Windows browsers commonly send no type at all for .md, and some send this
  // generic type for .docx — both fall back to the extension check either way.
  "application/octet-stream",
  "text/*",
];

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request,
      token: blobToken(),
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_IMPORT_BYTES,
        addRandomSuffix: true,
        // SEC-024-style: this token is used immediately by the same request
        // that just authenticated, so its life is short.
        validUntil: Date.now() + 2 * 60 * 1000,
      }),
      onUploadCompleted: async () => {
        // No-op — the browser POSTs the resulting URL to
        // /api/admin/blog/import itself; Vercel's webhook isn't reachable in
        // local dev, so nothing here can be depended on.
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Upload token generation failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
