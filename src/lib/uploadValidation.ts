// GAP-009 — server-side validation for document uploads.
//
// The upload endpoints accepted ANY file of ANY size, which is an abuse/DoS
// vector (huge files fill Blob storage; executables/HTML could be stored and
// later served). This restricts uploads to the document/image types the app
// actually needs, under a sane size cap. Checked server-side so a crafted client
// can't bypass it.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

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

/**
 * Validate an uploaded File's size and type. Accepts the file when EITHER its
 * MIME type or its extension is on the allow-list (browsers report HEIC/PDF MIME
 * inconsistently), and rejects anything oversized or of an unknown type.
 */
export function validateUpload(file: File): UploadCheck {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file provided" };
  }
  if (file.size === 0) {
    return { ok: false, error: "File is empty" };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: `File is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB)`,
    };
  }
  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_EXT.has(ext)) {
    return { ok: false, error: `Unsupported file type. Allowed: ${ALLOWED_LABEL}` };
  }
  return { ok: true };
}
