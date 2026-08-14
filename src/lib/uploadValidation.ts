// GAP-009 — server-side validation for document uploads.
//
// The upload endpoints accepted ANY file of ANY size, which is an abuse/DoS
// vector (huge files fill Blob storage; executables/HTML could be stored and
// later served). This restricts uploads to the document/image types the app
// actually needs, under a sane size cap. Checked server-side so a crafted client
// can't bypass it.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// The application-level ceiling for a client-uploaded document (identification,
// corporate docs). Enforced in three places so it can't be bypassed:
//   1. the drawer, before the browser starts uploading (friendly message),
//   2. the client-upload token route (`maximumSizeInBytes`) — Blob itself
//      rejects the PUT, so oversized bytes never land in the store,
//   3. the register step, via head() on the stored blob.
// Kept BELOW MAX_UPLOAD_BYTES, which still governs the legacy multipart path.
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const ALLOWED_EXT = new Set([
  "jpg",
  "jpeg",
  "png",
  "webp",
  "heic",
  "heif",
  "pdf",
]);

const ALLOWED_LABEL = "JPG, PNG, WEBP, HEIC, or PDF";

export type UploadCheck = { ok: true } | { ok: false; error: string };

/** Content types a client-upload token may be issued for. */
export const ALLOWED_UPLOAD_CONTENT_TYPES = [...ALLOWED_MIME];

/**
 * Validate a document by its METADATA (name / size / content type) rather than
 * by holding its bytes. This is what the direct-to-Blob path needs: the file
 * never reaches the server, so validation runs against `head()` metadata for the
 * already-stored blob. Same rules as validateUpload(), which now delegates here.
 */
export function validateUploadMeta(
  meta: { name?: string | null; size?: number | null; type?: string | null },
  maxBytes: number = MAX_UPLOAD_BYTES,
): UploadCheck {
  if (!meta || typeof meta.size !== "number") {
    return { ok: false, error: "No file provided" };
  }
  if (meta.size === 0) {
    return { ok: false, error: "File is empty" };
  }
  if (meta.size > maxBytes) {
    return {
      ok: false,
      error: `File is too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)`,
    };
  }
  const mime = (meta.type || "").toLowerCase();
  const ext = (meta.name || "").split(".").pop()?.toLowerCase() || "";
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_EXT.has(ext)) {
    return { ok: false, error: `Unsupported file type. Allowed: ${ALLOWED_LABEL}` };
  }
  return { ok: true };
}

/**
 * Validate an uploaded File's size and type. Accepts the file when EITHER its
 * MIME type or its extension is on the allow-list (browsers report HEIC/PDF MIME
 * inconsistently), and rejects anything oversized or of an unknown type.
 */
export function validateUpload(file: File): UploadCheck {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file provided" };
  }
  return validateUploadMeta({ name: file.name, size: file.size, type: file.type });
}
