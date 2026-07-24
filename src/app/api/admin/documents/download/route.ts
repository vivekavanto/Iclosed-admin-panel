import { NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";

/**
 * GET /api/admin/documents/download?u=<private-blob-url>
 *
 * Auth-gated streaming proxy for PRIVATE document blobs (SEC-003 / CMP-001).
 *
 * src/middleware.ts already requires an authenticated admin session for every
 * /api/admin/* path, so reaching this handler means the caller is an admin.
 * We fetch the private blob's bytes SERVER-SIDE using the private store token and
 * stream them back; the private blob URL is never usable by the browser on its
 * own, so a leaked URL (browser history, screenshot, referrer) no longer exposes
 * the document — access always goes through this auth check.
 *
 * Legacy/public documents never reach here: docDownloadHref() only points the
 * browser at this route for `.private.` blob URLs; public URLs are linked
 * directly, exactly as before.
 */
export const runtime = "nodejs";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams.get("u");
  if (!u) {
    return NextResponse.json(
      { success: false, error: "Missing 'u' parameter" },
      { status: 400 },
    );
  }

  // SSRF guard: this proxy fetches with a privileged blob token, so it must only
  // ever be pointed at Vercel Blob URLs — never an arbitrary attacker URL.
  if (!isBlobUrl(u)) {
    return NextResponse.json(
      { success: false, error: "Not a Vercel Blob URL" },
      { status: 400 },
    );
  }

  try {
    const result = await get(u, {
      access: "private",
      // Pick the token by the URL's store so this survives a flag rollback.
      token: blobTokenForUrl(u),
    });

    if (!result || !result.stream) {
      return NextResponse.json(
        { success: false, error: "Document not found" },
        { status: 404 },
      );
    }

    const headers = new Headers();
    headers.set(
      "Content-Type",
      result.blob?.contentType || "application/octet-stream",
    );
    if (result.blob?.size != null) {
      headers.set("Content-Length", String(result.blob.size));
    }
    // Never let a shared cache hold private document bytes.
    headers.set("Cache-Control", "private, no-store");

    // Preserve the original filename for the "Save as" dialog. `inline` lets the
    // browser preview (PDF/image) in a tab while still offering download.
    let filename = "document";
    try {
      filename =
        decodeURIComponent(new URL(u).pathname.split("/").pop() || "") ||
        "document";
    } catch {
      /* keep default */
    }
    headers.set(
      "Content-Disposition",
      `inline; filename="${filename.replace(/["\\]/g, "")}"`,
    );

    return new Response(result.stream as ReadableStream, {
      status: 200,
      headers,
    });
  } catch (err: any) {
    console.error("[documents/download] error:", err?.message || err);
    return NextResponse.json(
      { success: false, error: "Download failed" },
      { status: 500 },
    );
  }
}
