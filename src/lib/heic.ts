// HEIC detection + browser-side decoding, shared by the PDF export (dealPdf.ts)
// and the in-tab document viewer (docViewer.ts).
//
// iPhones photograph IDs as HEIC and the upload drawer accepts .heic, but
// neither pdf-lib nor Chrome/Firefox can decode it: in a PDF export it lands as
// a "can't be previewed" placeholder, and in a browser tab it silently turns
// into a download. Both paths therefore convert to JPEG first.

/**
 * True when a stored file is HEIC/HEIF. Detected on the filename OR the content
 * type: Vercel Blob echoes back whatever the browser reported at upload time,
 * which for .heic is often a bare "application/octet-stream".
 */
export function isHeic(
  name?: string | null,
  contentType?: string | null,
): boolean {
  // Normalise before matching: this is called with either a stored file_name
  // (which can carry stray whitespace) or, as a fallback, the blob URL (which
  // can carry a ?query or #hash). A bare endsWith on the raw string misses both
  // and the file would silently fall through as an unconvertible attachment.
  const n = (name ?? "")
    .trim()
    .toLowerCase()
    .split(/[?#]/)[0]
    .trim();
  const ct = (contentType ?? "").toLowerCase();
  return (
    n.endsWith(".heic") ||
    n.endsWith(".heif") ||
    ct.includes("heic") ||
    ct.includes("heif")
  );
}

/**
 * Decode HEIC to JPEG in the browser via libheif (WASM). Imported dynamically
 * because the decoder is a ~2.9MB chunk (the wasm is inlined as base64, so
 * there is no separate asset to serve); it downloads only when a document that
 * is actually HEIC is exported or opened, and never otherwise. The `/csp` build
 * avoids `unsafe-eval`, so this keeps working when the CSP in next.config.ts is
 * switched from report-only to enforcing — that build spawns libheif in a
 * blob: worker, which is why the CSP carries `worker-src 'self' blob:`.
 *
 * Returns null on failure so callers can fall back (a placeholder PDF page, or
 * a plain download) rather than losing the whole operation.
 */
export async function heicToJpegBytes(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    const { heicTo } = await import("heic-to/csp");
    const jpegBlob = await heicTo({
      blob: new Blob([bytes as unknown as BlobPart], { type: "image/heic" }),
      type: "image/jpeg",
      quality: 0.92,
    });
    return new Uint8Array(await jpegBlob.arrayBuffer());
  } catch {
    return null;
  }
}
