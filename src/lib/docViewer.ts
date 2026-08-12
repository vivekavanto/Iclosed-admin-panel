// Open a stored document in a new tab for VIEWING (as opposed to downloading).
//
// Why this exists: linking straight at the stored URL does not view the file.
//   • Vercel Blob serves most documents with `content-disposition: attachment`
//     (it only sends `inline` for a short allow-list of content types), so a
//     plain <a target="_blank"> saves the file and flashes an empty tab instead
//     of showing it.
//   • Files uploaded with an empty/generic content type land in the store as
//     `application/octet-stream`, which every browser downloads regardless of
//     disposition.
//   • iPhone IDs are HEIC, which Chrome and Firefox cannot decode at all.
//
// So we fetch the bytes ourselves, fix the MIME type (converting HEIC to JPEG
// with the same libheif decoder the PDF export uses), and hand the tab a
// same-origin object URL. Object URLs carry no content-disposition, so the
// browser renders anything it can decode — PDF, PNG, JPEG, GIF, WEBP, plain
// text — inline, and only falls back to a download for formats it genuinely
// cannot display.
//
// Client-only: uses window / URL.createObjectURL.

import { docDownloadHref, docFetchCredentials } from "@/lib/blobPrivacy";
import { isHeic, heicToJpegBytes } from "@/lib/heic";

export interface ViewableDoc {
  file_url?: string | null;
  file_name?: string | null;
}

// Extension → MIME, used only when the stored content type is missing or the
// useless generic one. Covers everything uploadValidation.ts accepts.
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
};

const GENERIC_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
]);

function extensionOf(name: string): string {
  const clean = (name ?? "").trim().toLowerCase().split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  return dot === -1 ? "" : clean.slice(dot + 1);
}

/** The type to render with: the stored one unless it is missing/generic. */
function displayMime(name: string, storedType: string | null): string {
  const stored = (storedType ?? "").toLowerCase().split(";")[0].trim();
  if (!GENERIC_TYPES.has(stored)) return stored;
  return EXT_MIME[extensionOf(name)] ?? "";
}

// The tab is opened synchronously (see below) and only navigated once the bytes
// are ready, so it would otherwise sit blank for the length of the fetch — and
// a HEIC decode adds a second or two on top of that.
function writePlaceholder(tab: Window, fileName: string): void {
  try {
    tab.document.write(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(fileName)}</title>` +
        `<body style="margin:0;display:flex;align-items:center;justify-content:center;` +
        `height:100vh;font:14px system-ui,sans-serif;color:#64748b">Opening document…</body>`,
    );
    tab.document.close();
  } catch {
    /* placeholder is cosmetic — never let it break the open */
  }
}

function escapeHtml(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

/**
 * Open `doc` in a new tab, rendered inline where the browser can.
 *
 * Returns false when nothing could be opened — either the popup was blocked or
 * the file could not be fetched — so the caller can surface a toast. A HEIC
 * whose decode fails is NOT a failure: the tab falls back to the original file
 * (which downloads), because there is nothing else a browser can do with it.
 */
export async function openDocForViewing(doc: ViewableDoc): Promise<boolean> {
  const url = doc?.file_url;
  if (!url) return false;

  const fileName = doc.file_name || "Document";
  // Must happen synchronously inside the click handler: a window.open() after
  // an `await` is treated as an unrequested popup and blocked. `noopener` is
  // deliberately NOT passed — with it, window.open returns null and we would
  // have no handle to navigate. The tab only ever shows same-origin object
  // URLs, so there is no cross-origin opener to protect against.
  const tab = window.open("", "_blank");
  if (tab) writePlaceholder(tab, fileName);

  // Private docs stream through the same-origin auth-gated proxy (needs the
  // session cookie); public/legacy blobs are fetched directly with no creds.
  const href = docDownloadHref(url);

  try {
    const res = await fetch(href, { credentials: docFetchCredentials(url) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let blob = await res.blob();
    const storedType = blob.type || res.headers.get("content-type");

    if (isHeic(fileName, storedType) || isHeic(url, storedType)) {
      const jpeg = await heicToJpegBytes(
        new Uint8Array(await blob.arrayBuffer()),
      );
      // Decode failed (corrupt file, unsupported HEIC profile): fall through
      // with the original bytes — the browser will download them.
      blob = jpeg
        ? new Blob([jpeg as unknown as BlobPart], { type: "image/jpeg" })
        : blob;
    } else {
      const mime = displayMime(fileName, storedType);
      if (mime && mime !== blob.type) blob = new Blob([blob], { type: mime });
    }

    const objectUrl = URL.createObjectURL(blob);
    if (tab) {
      tab.location.href = objectUrl;
    } else if (!window.open(objectUrl, "_blank")) {
      // Popup blocked both times — nothing was shown.
      URL.revokeObjectURL(objectUrl);
      return false;
    }
    // Long enough for the tab to have loaded the bytes; revoking earlier can
    // race a slow render, and never revoking leaks the file until reload.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);
    return true;
  } catch {
    // CORS, auth or network failure — hand the tab the raw link so the user
    // still gets the file (as a download) rather than a blank page.
    if (tab) {
      tab.location.href = href;
      return true;
    }
    return false;
  }
}
