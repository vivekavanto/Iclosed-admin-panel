// Collects every document a client family has uploaded, ready to hang off an
// email as attachments.
//
// Built for the "all tasks completed" admin alert: when the back office is told
// a file is finished, the whole document package should be in that email rather
// than behind ten clicks in the portal.
//
// Documents live in FIVE places in this schema, and all five matter:
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
//   • `tasks.document_url`       — a document hung directly off a task rather
//                                  than off one of its form fields (the tasks
//                                  PATCH route writes it, and the deal page
//                                  renders it as the task's document). No sweep
//                                  looked here at all.
//   • `deal_documents`            — deal-keyed document rows. Nothing in this
//                                  repo writes them, but the right-to-be-
//                                  forgotten erase sweeps the table for blobs,
//                                  so rows with a `file_url` do exist and would
//                                  otherwise never reach a clerk.
//
// The last two are queried on their own rather than inside the Promise.all
// below: a failure there falls into the shared catch, which abandons the WHOLE
// sweep and sends an email with no documents at all. Isolated, an unexpected
// schema costs only its own store.
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
import { createDocumentLink } from "./documentLink";
import { logger } from "./logger";

/**
 * How many bytes of attachments we're willing to put on one email.
 *
 * Well under Resend's ~40MB ceiling on purpose: attachments are base64-encoded
 * in transit, which inflates them by ~33%, and the HTML body plus headers ride
 * along too. 25MB of source bytes lands around 33MB on the wire.
 *
 * Raised from 20MB on 2026-09-03: a Sale file with several photo IDs was
 * spending the budget on higher-priority documents and linking the
 * identification scans, which are the ones a clerk most needs in hand. The
 * ceiling is the real constraint here, not the packing order — see the note on
 * dedupe() about why documents cannot be sorted by size.
 */
export const ATTACHMENT_BUDGET_BYTES = 25 * 1024 * 1024;

/** Refuse to even try a single file bigger than this — it would eat the budget. */
const MAX_SINGLE_FILE_BYTES = 10 * 1024 * 1024;

export interface EmailAttachment {
  filename: string;
  content: Buffer;
}

/** A document that could not be attached — surfaced as a link instead. */
export interface LinkedDocument {
  filename: string;
  /**
   * Where the recipient is sent. Defaults to the ADMIN download proxy, which
   * only works for someone already signed into the admin app; pass the package
   * through withEmailDocumentLinks() before emailing it to anyone else.
   */
  href: string;
  /** The blob itself, so a caller can mint a tokenised link over it. */
  fileUrl: string;
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
  /** The name the recipient sees — see packageFileName(). */
  fileName: string;
  /** Sort key — client task uploads are the most relevant, so they attach first. */
  priority: number;
}

/** Context used to rename documents into the firm's filing convention. */
export interface DocumentNaming {
  /**
   * File number the package belongs to, e.g. "26S-0356". Omit it and documents
   * keep the name they were uploaded under — every caller that doesn't pass one
   * behaves exactly as before.
   */
  fileNumber?: string | null;
  /**
   * Blob URLs the caller has already packaged another way — the identification
   * documents merged into the clerk email's combined PDF, for instance. Skipped
   * here so the same file isn't also attached on its own.
   */
  excludeUrls?: Set<string>;
  /**
   * Attachment allowance left for this package. Defaults to the full
   * ATTACHMENT_BUDGET_BYTES; a caller that has already spent part of the
   * email's budget (again: the combined PDFs) passes what remains.
   */
  budgetBytes?: number;
}

/** Strip characters that break a filename on Windows/macOS or in a mail client. */
function sanitizeNamePart(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split "passport.jpg" into { stem: "passport", ext: "jpg" }. */
function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: "" };
  const ext = name.slice(dot + 1);
  // Only a short alphanumeric tail counts as an extension, so "Smith, J. Jr"
  // doesn't lose "Jr".
  if (!/^[A-Za-z0-9]{1,5}$/.test(ext)) return { stem: name, ext: "" };
  return { stem: name.slice(0, dot), ext };
}

/**
 * "26S-0356 - Photo Identification - Pavithra Kumar.jpg"
 *
 * Clerks file by FILE NUMBER and search by client name, so the name the file
 * was uploaded under ("IMG_4821.jpg", "1759923628_1759.pdf") is replaced with
 * `<file number> - <task name> - <client name>`, keeping the original
 * extension. Two files from the same task and person collide by design —
 * dedupe() numbers the repeats.
 *
 * Falls back to the original name whenever there is nothing to build from.
 */
function packageFileName(opts: {
  fileNumber?: string | null;
  taskName?: string | null;
  clientName?: string | null;
  originalName: string;
}): string {
  const parts = [opts.fileNumber, opts.taskName, opts.clientName]
    .map((part) => sanitizeNamePart(part ?? ""))
    .filter(Boolean);
  if (parts.length === 0) return opts.originalName;
  const { ext } = splitExt(opts.originalName);
  return ext ? `${parts.join(" - ")}.${ext}` : parts.join(" - ");
}

/** Readable "task name" for a document that hangs off a lead rather than a task. */
function docTypeLabel(docType: string | null | undefined): string {
  const key = String(docType ?? "").toLowerCase().trim();
  if (!key) return "";
  const known: Record<string, string> = {
    aps: "Agreement of Purchase and Sale",
    aps_purchase: "Agreement of Purchase and Sale",
    aps_sale: "Agreement of Purchase and Sale",
    identification: "Identification",
    retainer_agreement: "Retainer Agreement",
    home_insurance: "Home Insurance",
    final_report: "Final Report",
  };
  if (known[key]) return known[key];
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** APS rows keep their uploaded name — see the naming note on collectFamilyDocuments. */
function isApsDocType(docType: string | null | undefined): boolean {
  return String(docType ?? "").toLowerCase().trim().startsWith("aps");
}

/** Pull a stored document's bytes, whichever blob store it lives in. */
export async function downloadDoc(fileUrl: string): Promise<Buffer> {
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
  // Priority is the ONLY sort key available here, and deliberately so: no store
  // records a file's size (there is no file_size column on any of them), so a
  // byte count exists only after downloadDoc() has already fetched the bytes.
  // Sorting smallest-first would therefore mean downloading every document on
  // the file before deciding what to attach — and it would optimise for the
  // NUMBER of attachments rather than their importance, which is the wrong
  // trade for a clerk who needs the identification more than three small task
  // uploads. Raise ATTACHMENT_BUDGET_BYTES instead when files start spilling.
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
 * NAMING: pass `naming.fileNumber` and every document is renamed to
 * `<file number> - <task name> - <client name>.<ext>` so the recipient can file
 * and search them. TWO exceptions keep the name they were uploaded under:
 * anything uploaded against the APS task (task_templates.is_aps_task — the APS
 * itself and its supporting documents) and any lead_corporate_docs row whose
 * doc_type starts with "aps". The firm files those by their own reference.
 *
 * @param familyDealIds every deal in the family (from getFamilyDealIds)
 * @param familyLeadIds every lead in the family (root + co-persons)
 * @param baseUrl absolute admin origin, for building links to non-attached docs
 * @param naming file-number context for renaming; omit to keep uploaded names
 */
export async function collectFamilyDocuments(
  familyDealIds: string[],
  familyLeadIds: string[],
  baseUrl: string,
  naming: DocumentNaming = {},
): Promise<FamilyDocumentPackage> {
  const empty: FamilyDocumentPackage = {
    attachments: [],
    linked: [],
    total: 0,
    attachedBytes: 0,
  };

  const candidates: CandidateDoc[] = [];

  try {
    // Task ids first — task_responses is keyed by task, not deal. The task's
    // title and its deal's client are what the renamed files are built from.
    const { data: tasks } = familyDealIds.length
      ? await supabaseAdmin
          .from("tasks")
          // document_url / document_name ride along on the query we already
          // make — a document attached to the task itself rather than to one of
          // its form fields.
          .select("id, title, deal_id, task_template_id, document_url, document_name")
          .in("deal_id", familyDealIds)
          .eq("is_deleted", false)
      : { data: [] };
    const taskIds = (tasks ?? []).map((t) => t.id);
    const templateIds = Array.from(
      new Set((tasks ?? []).map((t) => t.task_template_id).filter(Boolean)),
    ) as string[];

    const [
      { data: responses },
      { data: corporate },
      { data: identification },
      { data: apsTemplates },
      { data: dealRows },
      { data: leadRows },
    ] = await Promise.all([
        taskIds.length
          ? supabaseAdmin
              .from("task_responses")
              .select("task_id, file_url, file_name, field_label")
              .in("task_id", taskIds)
              .eq("field_type", "file")
          : Promise.resolve({ data: [] }),
        familyLeadIds.length
          ? supabaseAdmin
              .from("lead_corporate_docs")
              .select("lead_id, file_url, file_name, doc_type, custom_type")
              .in("lead_id", familyLeadIds)
          : Promise.resolve({ data: [] }),
        familyLeadIds.length
          ? supabaseAdmin
              .from("lead_identification_docs")
              .select("lead_id, file_url, file_name")
              .in("lead_id", familyLeadIds)
          : Promise.resolve({ data: [] }),
        templateIds.length
          ? supabaseAdmin
              .from("task_templates")
              .select("id")
              .in("id", templateIds)
              .eq("is_aps_task", true)
          : Promise.resolve({ data: [] }),
        familyDealIds.length
          ? supabaseAdmin.from("deals").select("id, lead_id").in("id", familyDealIds)
          : Promise.resolve({ data: [] }),
        familyLeadIds.length
          ? supabaseAdmin
              .from("leads")
              .select("id, first_name, last_name")
              .in("id", familyLeadIds)
          : Promise.resolve({ data: [] }),
      ]);

    const leadNameById = new Map<string, string>(
      (leadRows ?? []).map((l) => [
        l.id as string,
        `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim(),
      ]),
    );
    const clientNameByDeal = new Map<string, string>(
      (dealRows ?? []).map((d) => [
        d.id as string,
        (d.lead_id ? leadNameById.get(d.lead_id as string) : "") ?? "",
      ]),
    );
    const apsTemplateIds = new Set((apsTemplates ?? []).map((t) => t.id as string));
    const taskById = new Map(
      (tasks ?? []).map((t) => [
        t.id as string,
        {
          title: (t.title as string) ?? "",
          clientName: clientNameByDeal.get(t.deal_id as string) ?? "",
          isAps: t.task_template_id
            ? apsTemplateIds.has(t.task_template_id as string)
            : false,
        },
      ]),
    );

    (responses ?? []).forEach((r, i) => {
      if (!r.file_url) return;
      const original = r.file_name || r.field_label || fallbackName(r.file_url, i);
      const task = taskById.get(r.task_id as string);
      candidates.push({
        fileUrl: r.file_url,
        // The APS and everything else uploaded against the APS task keep the
        // name they arrived with — the firm files those by their own reference.
        fileName: task?.isAps
          ? original
          : packageFileName({
              fileNumber: naming.fileNumber,
              taskName: task?.title,
              clientName: task?.clientName,
              originalName: original,
            }),
        priority: 0,
      });
    });

    (corporate ?? []).forEach((d, i) => {
      if (!d.file_url) return;
      const original =
        d.file_name || d.custom_type || d.doc_type || fallbackName(d.file_url, i);
      candidates.push({
        fileUrl: d.file_url,
        fileName: isApsDocType(d.doc_type)
          ? original
          : packageFileName({
              fileNumber: naming.fileNumber,
              // No task behind these rows — the doc type is the closest thing to
              // a task name ("Retainer Agreement", "Identification").
              taskName: docTypeLabel(d.doc_type),
              clientName: leadNameById.get(d.lead_id as string),
              originalName: original,
            }),
        priority: 1,
      });
    });

    // A document hung off the TASK itself. Same naming as a task response,
    // because to a clerk it is the same thing: this task's document.
    (tasks ?? []).forEach((t, i) => {
      const url = (t as { document_url?: string | null }).document_url;
      if (!url) return;
      const original =
        (t as { document_name?: string | null }).document_name ||
        fallbackName(url, i);
      candidates.push({
        fileUrl: url,
        fileName: apsTemplateIds.has((t.task_template_id as string) ?? "")
          ? original
          : packageFileName({
              fileNumber: naming.fileNumber,
              taskName: (t.title as string) ?? "",
              clientName: clientNameByDeal.get(t.deal_id as string),
              originalName: original,
            }),
        priority: 0,
      });
    });

    (identification ?? []).forEach((d, i) => {
      if (!d.file_url) return;
      const original = d.file_name || fallbackName(d.file_url, i);
      candidates.push({
        fileUrl: d.file_url,
        fileName: packageFileName({
          fileNumber: naming.fileNumber,
          taskName: "Identification",
          clientName: leadNameById.get(d.lead_id as string),
          originalName: original,
        }),
        priority: 2,
      });
    });
  } catch (err) {
    logger.error("[familyDocuments] failed to gather document rows:", err);
    return empty;
  }

  // `deal_documents` on its own: nothing in this repo writes the table, so its
  // shape is the one thing here we don't control. A failure logs and costs only
  // these rows — never the documents gathered above.
  if (familyDealIds.length) {
    try {
      const { data: dealDocs, error } = await supabaseAdmin
        .from("deal_documents")
        .select("deal_id, file_url, name, type")
        .in("deal_id", familyDealIds);
      if (error) throw new Error(error.message);
      (dealDocs ?? []).forEach((d, i) => {
        if (!d.file_url) return;
        const original = (d.name as string) || (d.type as string) || fallbackName(d.file_url, i);
        candidates.push({
          fileUrl: d.file_url as string,
          fileName: packageFileName({
            fileNumber: naming.fileNumber,
            taskName: (d.type as string) || "",
            clientName: "",
            originalName: original,
          }),
          // Last: any of the stores above knows more about a blob than this one
          // does, and dedupe() keeps the better-named copy.
          priority: 3,
        });
      });
    } catch (err) {
      logger.warn("[familyDocuments] deal_documents sweep failed — skipping that store:", err);
    }
  }

  const exclude = naming.excludeUrls;
  const docs = dedupe(candidates).filter((d) => !exclude?.has(d.fileUrl));
  if (docs.length === 0) return empty;

  const budget = naming.budgetBytes ?? ATTACHMENT_BUDGET_BYTES;

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
      fileUrl: doc.fileUrl,
      reason,
    });
  };

  for (const doc of docs) {
    if (attachedBytes >= budget) {
      linkFor(doc, "budget");
      continue;
    }
    try {
      const content = await downloadDoc(doc.fileUrl);
      if (content.byteLength > MAX_SINGLE_FILE_BYTES) {
        linkFor(doc, "too_large");
        continue;
      }
      if (attachedBytes + content.byteLength > budget) {
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
 * Swap the admin-proxy hrefs for ONE tokenised link the recipient can actually
 * open, and return the package with those links in place.
 *
 * Call this on any package whose `linked` list is about to be EMAILED. The
 * default hrefs point at /api/admin/documents/download, which middleware.ts
 * gates on an admin session — clicking one from an inbox returned
 * {"success":false,"error":"Unauthorized"}, which is precisely the document the
 * recipient did not otherwise get.
 *
 * Degrades rather than fails: if the token cannot be minted (most likely the
 * invitation_tokens type CHECK not yet widened for 'doc_link' — it is applied by
 * hand) the package comes back untouched, with the old links, and the email
 * still sends with all of its attachments.
 */
export async function withEmailDocumentLinks(
  pkg: FamilyDocumentPackage,
  opts: { email: string; dealId: string },
): Promise<FamilyDocumentPackage> {
  if (pkg.linked.length === 0) return pkg;

  const minted = await createDocumentLink({
    email: opts.email,
    dealId: opts.dealId,
    docs: pkg.linked.map((d) => ({ url: d.fileUrl, name: d.filename })),
  });
  if (!minted) return pkg;

  return {
    ...pkg,
    // Index order matches the order the docs were put on the token above, which
    // is what the route resolves `&i=` against.
    linked: pkg.linked.map((d, i) => ({ ...d, href: `${minted.url}&i=${i}` })),
  };
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
    `open ${linked.length === 1 ? "it" : "them"} here:</p>` +
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
