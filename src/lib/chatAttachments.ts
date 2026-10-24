// Files attached to a client-chat message (deal_messages.attachments).
//
// Bytes go browser -> Vercel Blob directly (@vercel/blob/client), like every
// other document upload here, so the 4.5 MB function body cap never applies.
// The token route only lets a browser write under chat/<root_lead_id>/, and the
// send route re-checks every URL with head() before it is stored — so a message
// can only ever carry files that were uploaded for THAT file's chat.
//
// Downloads always go through a thread-scoped route (admin:
// /api/admin/messages/<root>/attachment, portal: /api/messages/attachment),
// which serves the file only if it is attached to a live message in a thread
// the caller may read. Public blobs are redirected, private ones streamed.
//
// Isomorphic (no server-only imports). MIRRORED in the portal:
// iclosed_dev_web/src/lib/chatAttachments.ts — the limits and the path prefix
// must match, because either app may store an attachment the other serves.

export type ChatAttachment = {
  url: string;
  name: string;
  size: number;
  type: string;
};

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB, the document cap

export const CHAT_ATTACHMENT_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/** For the file picker's `accept`. */
export const CHAT_ATTACHMENT_ACCEPT =
  ".jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx," + CHAT_ATTACHMENT_TYPES.join(",");

export const CHAT_ATTACHMENT_LABEL = "images, PDF, Word or Excel";

/** Every chat upload for a file lives under this prefix. */
export function chatAttachmentPrefix(rootLeadId: string): string {
  return `chat/${rootLeadId}/`;
}

/** The blob pathname a browser uploads one chat file to. */
export function chatAttachmentPath(rootLeadId: string, fileName: string): string {
  const clean = fileName
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(-80);
  return `${chatAttachmentPrefix(rootLeadId)}${clean || "file"}`;
}

/** Client-side pre-check, before the browser starts uploading. */
export function checkChatAttachment(file: { name: string; size: number; type: string }): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 10 MB.`;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const typeOk = CHAT_ATTACHMENT_TYPES.includes((file.type || "").toLowerCase());
  const extOk = ["jpg", "jpeg", "png", "webp", "heic", "heif", "pdf", "doc", "docx", "xls", "xlsx"].includes(ext);
  if (!typeOk && !extOk) return `${file.name}: only ${CHAT_ATTACHMENT_LABEL} files can be attached.`;
  return null;
}

/**
 * A pasted screenshot arrives as "image.png" (or nameless): give it a readable,
 * unique name so two pastes in one message don't look like the same file.
 */
export function nameClipboardFile(file: File): File {
  const generic = !file.name || /^image\.(png|jpe?g|webp)$/i.test(file.name);
  if (!generic || typeof File === "undefined") return file;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return new File([file], `screenshot-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`, { type: file.type });
}

/** True when a drag carries files (not text or a link being dragged). */
export function dragHasFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

/** Shown inline as a thumbnail rather than a file chip. */
export function isImageAttachment(a: Pick<ChatAttachment, "type" | "name">): boolean {
  const t = (a.type || "").toLowerCase();
  // HEIC doesn't render in most browsers; keep it a file chip.
  return ["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(t);
}

/**
 * Opens in a browser tab (images, PDF). Everything else — Word, Excel, HEIC —
 * is downloaded under its original name, the way mail and chat apps do.
 */
export function isViewableAttachment(a: Pick<ChatAttachment, "type" | "name">): boolean {
  return isImageAttachment(a) || (a.type || "").toLowerCase() === "application/pdf";
}

/** ASCII fallback for Content-Disposition `filename=` (headers can't carry other characters). */
export function asciiFilename(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "").trim() || "attachment";
}

/** Full Content-Disposition value, keeping the real (UTF-8) name via filename*. */
export function contentDisposition(kind: "inline" | "attachment", name: string): string {
  return `${kind}; filename="${asciiFilename(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read the column defensively: anything malformed is dropped, never rendered. */
export function parseAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      url: typeof a.url === "string" ? a.url : "",
      name: typeof a.name === "string" && a.name ? a.name : "file",
      size: typeof a.size === "number" ? a.size : 0,
      type: typeof a.type === "string" ? a.type : "",
    }))
    .filter((a) => a.url);
}

/** "2 files" / "contract.pdf" — for previews and notifications of an attachment-only message. */
export function attachmentSummary(list: ChatAttachment[]): string {
  if (list.length === 0) return "";
  if (list.length === 1) return `📎 ${list[0].name}`;
  return `📎 ${list.length} files`;
}
