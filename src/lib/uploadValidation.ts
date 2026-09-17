// GAP-009 — server-side validation for document uploads.
//
// The upload endpoints accepted ANY file of ANY size, which is an abuse/DoS
// vector (huge files fill Blob storage; executables/HTML could be stored and
// later served). This restricts uploads to the document/image types the app
// actually needs, under a sane size cap. Checked server-side so a crafted client
// can't bypass it.

export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB

// The application-level ceiling for a client-uploaded document (identification,
// corporate docs). Enforced in three places so it can't be bypassed:
//   1. the drawer, before the browser starts uploading (friendly message),
//   2. the client-upload token route (`maximumSizeInBytes`) — Blob itself
//      rejects the PUT, so oversized bytes never land in the store,
//   3. the register step, via head() on the stored blob.
// Kept BELOW MAX_UPLOAD_BYTES, which still governs the legacy multipart path.
export const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * The ceiling for a post-closure FINAL REPORTING PACKAGE (doc_type
 * "final_report").
 *
 * Higher than every other document on purpose: a reporting package is a scanned
 * bundle — transfer, statement of adjustments, title policy, correspondence —
 * and 15-25 MB is the NORMAL size, not the outlier. At the 10 MB document cap
 * staff simply could not file one (the Blob PUT was rejected before any of our
 * code ran, which is what surfaced as an opaque "token" error in the toast).
 *
 * Raising the cap is only safe because the package is no longer emailed as an
 * ATTACHMENT — sendFinalReportEmail.ts sends a download link instead, so a
 * 30 MB report can't produce an email that Gmail/Outlook will bounce.
 */
export const MAX_FINAL_REPORT_BYTES = 30 * 1024 * 1024; // 30 MB

/** doc_types that upload under MAX_FINAL_REPORT_BYTES instead of the document cap. */
const LARGE_DOC_TYPES = new Set(["final_report", "other"]);

/**
 * The size ceiling for one doc_type. Every enforcement point (the drawer, the
 * client-upload token route, the register step) reads it from here, so the
 * three can't drift out of step and leave staff with a file the browser accepts
 * and Blob rejects.
 */
export function maxUploadBytesForDocType(docType?: string | null): number {
  return LARGE_DOC_TYPES.has((docType ?? "").trim().toLowerCase())
    ? MAX_FINAL_REPORT_BYTES
    : MAX_DOCUMENT_UPLOAD_BYTES;
}

/** "30 MB" — the same wording the validator puts in its error message. */
export function formatMaxUploadSize(bytes: number): string {
  return `${Math.floor(bytes / 1024 / 1024)} MB`;
}

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

// doc_type "other" also allows Office files, not just scans/images.
const OFFICE_MIME = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const OFFICE_EXT = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx"]);
const OFFICE_LABEL = "PDF, image, or Office file (Word, Excel, PowerPoint)";
const OFFICE_ALLOWED_DOC_TYPES = new Set(["other"]);

function allowsOfficeFiles(docType?: string | null): boolean {
  return OFFICE_ALLOWED_DOC_TYPES.has((docType ?? "").trim().toLowerCase());
}

export type UploadCheck = { ok: true } | { ok: false; error: string };

/** Content types a client-upload token may be issued for. */
export const ALLOWED_UPLOAD_CONTENT_TYPES = [...ALLOWED_MIME];

/** Content types allowed for one doc_type — widened for "other" (see above). */
export function allowedUploadContentTypesForDocType(docType?: string | null): string[] {
  return allowsOfficeFiles(docType)
    ? [...ALLOWED_MIME, ...OFFICE_MIME]
    : ALLOWED_UPLOAD_CONTENT_TYPES;
}

/**
 * Validate a document by its METADATA (name / size / content type) rather than
 * by holding its bytes. This is what the direct-to-Blob path needs: the file
 * never reaches the server, so validation runs against `head()` metadata for the
 * already-stored blob. Same rules as validateUpload(), which now delegates here.
 */
export function validateUploadMeta(
  meta: { name?: string | null; size?: number | null; type?: string | null },
  maxBytes: number = MAX_UPLOAD_BYTES,
  docType?: string | null,
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
  const office = allowsOfficeFiles(docType);
  const mimeOk = ALLOWED_MIME.has(mime) || (office && OFFICE_MIME.has(mime));
  const extOk = ALLOWED_EXT.has(ext) || (office && OFFICE_EXT.has(ext));
  if (!mimeOk && !extOk) {
    return {
      ok: false,
      error: `Unsupported file type. Allowed: ${office ? OFFICE_LABEL : ALLOWED_LABEL}`,
    };
  }
  return { ok: true };
}

/**
 * Validate an uploaded File's size and type. Accepts the file when EITHER its
 * MIME type or its extension is on the allow-list (browsers report HEIC/PDF MIME
 * inconsistently), and rejects anything oversized or of an unknown type.
 */
export function validateUpload(file: File, docType?: string | null): UploadCheck {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file provided" };
  }
  return validateUploadMeta(
    { name: file.name, size: file.size, type: file.type },
    maxUploadBytesForDocType(docType),
    docType,
  );
}

/** "133 KB" / "1.4 MB" — human file size for the documents list UI. */
export function formatFileSize(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
