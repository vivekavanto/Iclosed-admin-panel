// Collects every document a client family has uploaded, ready to hang off an
// email as attachments.
//
// Built for the "all tasks completed" admin alert: when the back office is told
// a file is finished, the whole document package should be in that email rather
// than behind ten clicks in the portal.
//
// Documents live in THREE places in this schema, and all three matter:
//
//   • `lead_corporate_docs`      — intake / admin uploads (IDs, APS, corporate
//                                  records, mortgage, home insurance…), keyed
//                                  by lead_id.
//   • `lead_identification_docs` — the older ID-only table, still populated by
//                                  UploadIdentificationDrawer. Keyed by lead_id.
//   • `task_responses`           — files the CLIENT uploaded to answer a task
//                                  form field, keyed by task_id. These are the
//                                  ones the alert is actually about, so missing
//                                  them would defeat the point.
//
// Everything is gathered FAMILY-wide (client + co-purchasers / co-sellers), the
// same scope the alert itself uses — a co-seller's ID belongs in the package.
//
// Size discipline: Resend rejects a message over ~40MB total, and a family file
// with photo IDs and a scanned APS can pass that easily. So attachments are
// accumulated until ATTACHMENT_BUDGET_BYTES is reached; everything after that
// (and anything that fails to download) is returned as `linked` so the caller
// can list it as download links instead. The email always sends.

import { get } from "@vercel/blob";
import supabaseAdmin from "./supabaseAdmin";
import { isPrivateBlobUrl, blobTokenForUrl, docDownloadHref } from "./blobPrivacy";
import { logger } from "./logger";

/**
 * How many bytes of attachments we're willing to put on one email.
 *
 * Well under Resend's ~40MB ceiling on purpose: attachments are base64-encoded
 * in transit, which inflates them by ~33%, and the HTML body plus headers ride
 * along too. 20MB of source bytes lands around 27MB on the wire, leaving room
 * to spare.
 */
export const ATTACHMENT_BUDGET_BYTES = 20 * 1024 * 1024;

/** Refuse to even try a single file bigger than this — it would eat the budget. */
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

/** A document that could not be attached — surfaced as a link instead. */
export interface LinkedDocument {
  filename: string;
  /** Absolute URL an admin can open (private docs go via the download proxy). */
  href: string;
  /** Why it wasn't attached, for the log and the email footnote. */
  reason: "budget" | "too_large" | "download_failed";
}

export interface FamilyDocumentPackage {
  attachments: EmailAttachment[];
  linked: LinkedDocument[];
  /** attachments.length + linked.length — every document found. */
  total: number;
  /** Sum of attached bytes, for logging. */
  attachedBytes: number;
}

interface CandidateDoc {
  fileUrl: string;
  fileName: string;
  /** Sort key — client task uploads are the most relevant, so they attach first. */
  priority: number;
}

/** Pull a stored document's bytes, whichever blob store it lives in. */
async function downloadDoc(fileUrl: string): Promise<Buffer> {
  if (isPrivateBlobUrl(fileUrl)) {
    const result = await get(fileUrl, {
      access: "private",
      token: blobTokenForUrl(fileUrl),
    });
    if (!result?.stream) throw new Error("private blob not found");
    return Buffer.from(await new Response(result.stream).arrayBuffer());
  }
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Derive a filename when the row has none. Blob pathnames are suffixed with a
 * random token by Vercel (`id-card-Xk29fa.pdf`), but it's still far better than
 * "document".
 */
function fallbackName(fileUrl: string, index: number): string {
  try {
    const last = new URL(fileUrl).pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // Not a parseable URL — fall through.
  }
  return `document-${index + 1}`;
}

/**
 * De-duplicate by URL and disambiguate repeated filenames.
 *
 * The same blob legitimately appears twice: completeApsTask bridges an intake
 * upload from `lead_corporate_docs` into `task_responses`, so an APS shows up in
 * both tables pointing at one file. Attaching it twice is just noise. Distinct
 * files that happen to share a name ("licence.jpg" from two co-purchasers) are
 * kept, but numbered, so the recipient can tell them apart.
 */
function dedupe(docs: CandidateDoc[]): CandidateDoc[] {
  const byUrl = new Map<string, CandidateDoc>();
  for (const doc of docs) {
    const existing = byUrl.get(doc.fileUrl);
    // Keep the higher-priority (lower number) copy so a client task upload wins
    // its name over the same file's intake row.
    if (!existing || doc.priority < existing.priority) byUrl.set(doc.fileUrl, doc);
  }

  const seenNames = new Map<string, number>();
  return Array.from(byUrl.values())
    .sort((a, b) => a.priority - b.priority)
    .map((doc) => {
      const count = seenNames.get(doc.fileName) ?? 0;
      seenNames.set(doc.fileName, count + 1);
      if (count === 0) return doc;
      const dot = doc.fileName.lastIndexOf(".");
      const fileName =
        dot > 0
          ? `${doc.fileName.slice(0, dot)} (${count + 1})${doc.fileName.slice(dot)}`
          : `${doc.fileName} (${count + 1})`;
      return { ...doc, fileName };
    });
}

/**
 * Every document uploaded across a deal family, downloaded and split into
 * attachments (within budget) and links (the rest).
 *
 * Best-effort by contract, like the alert that calls it: any failure to read a
 * table or a blob degrades that document to a link, and never throws.
 *
 * @param familyDealIds every deal in the family (from getFamilyDealIds)
 * @param familyLeadIds every lead in the family (root + co-persons)
 * @param baseUrl absolute admin origin, for building links to non-attached docs
 */
export async function collectFamilyDocuments(
  familyDealIds: string[],
  familyLeadIds: string[],
  baseUrl: string,
): Promise<FamilyDocumentPackage> {
  const empty: FamilyDocumentPackage = {
    attachments: [],
    linked: [],
    total: 0,
    attachedBytes: 0,
  };

  const candidates: CandidateDoc[] = [];

  try {
    // Task ids first — task_responses is keyed by task, not deal.
    const { data: tasks } = familyDealIds.length
      ? await supabaseAdmin
          .from("tasks")
          .select("id")
          .in("deal_id", familyDealIds)
          .eq("is_deleted", false)
      : { data: [] };
    const taskIds = (tasks ?? []).map((t) => t.id);

    const [{ data: responses }, { data: corporate }, { data: identification }] =
      await Promise.all([
        taskIds.length
          ? supabaseAdmin
              .from("task_responses")
              .select("file_url, file_name, field_label")
              .in("task_id", taskIds)
              .eq("field_type", "file")
          : Promise.resolve({ data: [] }),
        familyLeadIds.length
          ? supabaseAdmin
              .from("lead_corporate_docs")
              .select("file_url, file_name, doc_type, custom_type")
              .in("lead_id", familyLeadIds)
          : Promise.resolve({ data: [] }),
        familyLeadIds.length
          ? supabaseAdmin
              .from("lead_identification_docs")
              .select("file_url, file_name")
              .in("lead_id", familyLeadIds)
          : Promise.resolve({ data: [] }),
      ]);

    (responses ?? []).forEach((r, i) => {
      if (!r.file_url) return;
      candidates.push({
        fileUrl: r.file_url,
        fileName: r.file_name || r.field_label || fallbackName(r.file_url, i),
        priority: 0,
      });
    });

    (corporate ?? []).forEach((d, i) => {
      if (!d.file_url) return;
      candidates.push({
        fileUrl: d.file_url,
        fileName:
          d.file_name || d.custom_type || d.doc_type || fallbackName(d.file_url, i),
        priority: 1,
      });
    });

    (identification ?? []).forEach((d, i) => {
      if (!d.file_url) return;
      candidates.push({
        fileUrl: d.file_url,
        fileName: d.file_name || fallbackName(d.file_url, i),
        priority: 2,
      });
    });
  } catch (err) {
    logger.error("[familyDocuments] failed to gather document rows:", err);
    return empty;
  }

  const docs = dedupe(candidates);
  if (docs.length === 0) return empty;

  const attachments: EmailAttachment[] = [];
  const linked: LinkedDocument[] = [];
  let attachedBytes = 0;

  const linkFor = (doc: CandidateDoc, reason: LinkedDocument["reason"]) => {
    const href = docDownloadHref(doc.fileUrl);
    linked.push({
      filename: doc.fileName,
      // docDownloadHref returns a relative proxy path for private blobs; an
      // email needs an absolute one.
      href: href.startsWith("/") ? `${baseUrl}${href}` : href,
      reason,
    });
  };

  for (const doc of docs) {
    if (attachedBytes >= ATTACHMENT_BUDGET_BYTES) {
      linkFor(doc, "budget");
      continue;
    }
    try {
      const content = await downloadDoc(doc.fileUrl);
      if (content.byteLength > MAX_SINGLE_FILE_BYTES) {
        linkFor(doc, "too_large");
        continue;
      }
      if (attachedBytes + content.byteLength > ATTACHMENT_BUDGET_BYTES) {
        linkFor(doc, "budget");
        continue;
      }
      attachments.push({ filename: doc.fileName, content });
      attachedBytes += content.byteLength;
    } catch (err) {
      logger.warn(
        `[familyDocuments] could not download ${doc.fileName} — linking instead:`,
        err,
      );
      linkFor(doc, "download_failed");
    }
  }

  return {
    attachments,
    linked,
    total: attachments.length + linked.length,
    attachedBytes,
  };
}

/**
 * The document block appended to the alert email, generated in CODE rather than
 * templated.
 *
 * Deliberately not `{{ placeholders }}` in the email_templates row. That row
 * lives in the SHARED Supabase database, so it is read by every environment at
 * once — local, dev deploy, production — while the code that resolves its
 * placeholders ships per-deploy. Adding a new placeholder to the template
 * therefore renders as a literal "{{ attached_count }}" in any environment that
 * hasn't deployed the matching code yet, which is exactly what happened on
 * 2026-08-10. Generating this block here keeps the template stable and the
 * feature self-contained: an old deploy simply omits the block instead of
 * emailing raw template syntax.
 *
 * Returns "" when the family has no documents at all, so the email just doesn't
 * mention them.
 */
export function renderDocumentSummaryHtml(pkg: FamilyDocumentPackage): string {
  if (pkg.total === 0) return "";

  const attached = pkg.attachments.length;
  const sentence =
    attached > 0
      ? `<p style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
        `${attached === pkg.total ? "All " : ""}${attached} of their uploaded ` +
        `document${attached === 1 ? " is" : "s are"} attached to this email.</p>`
      : "";

  return sentence + renderLinkedDocsHtml(pkg.linked);
}

/** Renders the "not attached" list as an HTML fragment, or "" when there is none. */
export function renderLinkedDocsHtml(linked: LinkedDocument[]): string {
  if (linked.length === 0) return "";
  const items = linked
    .map(
      (d) =>
        `<li style="margin:2px 0;"><a href="${d.href}" style="color:#e11d48;">${escapeHtml(
          d.filename,
        )}</a></li>`,
    )
    .join("");
  return (
    `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e2e8f0;">` +
    `<p style="font-size:13px;color:#64748b;margin:0 0 6px;">` +
    `${linked.length} document${linked.length === 1 ? " was" : "s were"} too large to attach — ` +
    `open ${linked.length === 1 ? "it" : "them"} in the portal:</p>` +
    `<ul style="font-size:13px;color:#64748b;margin:0;padding-left:18px;">${items}</ul>` +
    `</div>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
