// Gathers the data behind the two MERGED PDFs the conveyancing clerks asked for.
//
// "Email to Clerk" used to attach every document on its own — a two-person file
// meant four separate ID files and two personal-information reports, and the
// clerk opened each in turn to read one thing. They asked for the per-person
// paperwork combined instead:
//
//   • "<file> - Identification.pdf"       — every party's ID, in one document
//   • "<file> - Personal Information.pdf" — every party's form answers, in one
//
// Everything else on the file (APS, mortgage, insurance…) still travels as its
// own original file, because merging those flattens formatting the firm relies
// on. sendClerkDocumentsEmail.ts stitches the two halves together.
//
// This module is the queries; clerkCombinedPdf.ts is the layout. A document that
// can't be embedded server-side (HEIC, a progressive JPEG) comes back in
// `skipped` and is deliberately absent from `consumedUrls`, so the caller keeps
// attaching it separately — a clerk never loses a document.

import supabaseAdmin from "./supabaseAdmin";
import { downloadDoc, type EmailAttachment } from "./familyDocuments";
import {
  renderIdentificationPdf,
  renderPersonalInfoPdf,
  type ClerkIdDoc,
  type ClerkInfoRow,
  type ClerkPerson,
} from "./clerkCombinedPdf";
import { logger } from "./logger";

export type { ClerkPerson } from "./clerkCombinedPdf";

export interface CombinedClerkDocs {
  /** The merged PDFs, ready to attach. Empty when there was nothing to merge. */
  attachments: EmailAttachment[];
  /**
   * Blob URLs that ARE now inside the identification PDF. The caller excludes
   * them from the per-document attachments so nothing is sent twice; a document
   * that couldn't be embedded is deliberately absent from this set.
   */
  consumedUrls: Set<string>;
  /** ID documents merged in. */
  identificationDocs: number;
  /** Parties whose personal information made it into the merged report. */
  personalInfoPeople: number;
  /** Bytes the merged PDFs occupy, so the caller can spend the rest of its budget. */
  bytes: number;
}

const EMPTY: CombinedClerkDocs = {
  attachments: [],
  consumedUrls: new Set(),
  identificationDocs: 0,
  personalInfoPeople: 0,
  bytes: 0,
};

/** "driver_licence" → "Driver Licence"; matches the deal page's formatIdDocLabel. */
function formatIdLabel(customType: string | null | undefined): string {
  const raw = String(customType ?? "").trim();
  if (!raw) return "Identification Document";
  return raw.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Same loose title matching the deal page and the customer portal use. */
function isIdentificationTitle(title: string | null | undefined): boolean {
  return String(title ?? "").toLowerCase().includes("identif");
}

function isPersonalInfoTitle(title: string | null | undefined): boolean {
  return String(title ?? "").toLowerCase().includes("personal info");
}

/**
 * Every party's identification documents, keyed by lead, deduped by blob URL.
 *
 * All three stores are consulted for the same reason collectFamilyDocuments
 * consults them: "Save draft", "Replace" and "Clone from previous deal" write
 * only to lead_corporate_docs, while a client answering the task writes only to
 * task_responses. Reading one of them alone loses somebody's ID.
 */
async function loadIdentificationDocs(
  leadIds: string[],
  dealIds: string[],
): Promise<Map<string, ClerkIdDoc[]>> {
  const byLead = new Map<string, ClerkIdDoc[]>();
  if (leadIds.length === 0) return byLead;

  const [{ data: corporate }, { data: legacy }, { data: deals }, { data: tasks }] =
    await Promise.all([
      supabaseAdmin
        .from("lead_corporate_docs")
        .select("lead_id, file_url, file_name, custom_type, created_at")
        .in("lead_id", leadIds)
        .eq("doc_type", "identification")
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("lead_identification_docs")
        .select("lead_id, file_url, file_name")
        .in("lead_id", leadIds),
      dealIds.length
        ? supabaseAdmin.from("deals").select("id, lead_id").in("id", dealIds)
        : Promise.resolve({ data: [] }),
      dealIds.length
        ? supabaseAdmin
            .from("tasks")
            .select("id, title, deal_id")
            .in("deal_id", dealIds)
            .eq("is_deleted", false)
        : Promise.resolve({ data: [] }),
    ]);

  const idTasks = (tasks ?? []).filter((t) => isIdentificationTitle(t.title as string));
  const leadByDeal = new Map<string, string>(
    (deals ?? []).map((d) => [d.id as string, (d.lead_id as string) ?? ""]),
  );
  const { data: responses } = idTasks.length
    ? await supabaseAdmin
        .from("task_responses")
        .select("task_id, file_url, file_name, field_label")
        .in(
          "task_id",
          idTasks.map((t) => t.id as string),
        )
        .eq("field_type", "file")
    : { data: [] };
  const dealByTask = new Map<string, string>(
    idTasks.map((t) => [t.id as string, (t.deal_id as string) ?? ""]),
  );

  const known = new Set(leadIds);
  const seen = new Set<string>();
  const push = (doc: ClerkIdDoc) => {
    if (!doc.fileUrl || !known.has(doc.leadId) || seen.has(doc.fileUrl)) return;
    seen.add(doc.fileUrl);
    byLead.set(doc.leadId, [...(byLead.get(doc.leadId) ?? []), doc]);
  };

  for (const d of corporate ?? []) {
    push({
      leadId: d.lead_id as string,
      fileUrl: d.file_url as string,
      fileName: (d.file_name as string) || "Identification",
      label: formatIdLabel(d.custom_type as string | null),
    });
  }
  for (const r of responses ?? []) {
    push({
      leadId: leadByDeal.get(dealByTask.get(r.task_id as string) ?? "") ?? "",
      fileUrl: r.file_url as string,
      fileName: (r.file_name as string) || "Identification",
      label: (r.field_label as string) || "Identification Document",
    });
  }
  for (const d of legacy ?? []) {
    push({
      leadId: d.lead_id as string,
      fileUrl: d.file_url as string,
      fileName: (d.file_name as string) || "Identification",
      label: "Identification Document",
    });
  }

  return byLead;
}

/**
 * Every party's personal-information answers, keyed by lead, in the order the
 * client-facing form asks them.
 *
 * File-type answers are skipped: the merged report is about the ANSWERS, and any
 * document attached to the task still reaches the clerk as its own attachment.
 */
async function loadPersonalInfo(
  leadIds: string[],
  dealIds: string[],
): Promise<Map<string, ClerkInfoRow[]>> {
  const byLead = new Map<string, ClerkInfoRow[]>();
  if (dealIds.length === 0) return byLead;

  const [{ data: deals }, { data: tasks }] = await Promise.all([
    supabaseAdmin.from("deals").select("id, lead_id").in("id", dealIds),
    supabaseAdmin
      .from("tasks")
      .select("id, title, deal_id, task_template_id")
      .in("deal_id", dealIds)
      .eq("is_deleted", false),
  ]);

  const infoTasks = (tasks ?? []).filter((t) => isPersonalInfoTitle(t.title as string));
  if (infoTasks.length === 0) return byLead;

  const leadByDeal = new Map<string, string>(
    (deals ?? []).map((d) => [d.id as string, (d.lead_id as string) ?? ""]),
  );
  const templateIds = Array.from(
    new Set(infoTasks.map((t) => t.task_template_id as string | null).filter(Boolean)),
  ) as string[];

  const [{ data: responses }, { data: fields }] = await Promise.all([
    supabaseAdmin
      .from("task_responses")
      .select("task_id, field_id, field_label, field_type, value")
      .in(
        "task_id",
        infoTasks.map((t) => t.id as string),
      ),
    templateIds.length
      ? supabaseAdmin
          .from("task_form_fields")
          .select("id, label, order_index")
          .in("task_template_id", templateIds)
      : Promise.resolve({ data: [] }),
  ]);

  // Same two-key lookup the deal page's PDF export uses: by field id first, by
  // label for rows written before the field had one.
  const orderByField = new Map<string, number>();
  (fields ?? []).forEach((f, i) => {
    const order = Number(f.order_index ?? i);
    if (f.id) orderByField.set(String(f.id), order);
    const label = String(f.label ?? "").trim().toLowerCase();
    if (label && !orderByField.has(label)) orderByField.set(label, order);
  });
  const orderOf = (r: { field_id?: unknown; field_label?: unknown }) =>
    (r.field_id ? orderByField.get(String(r.field_id)) : undefined) ??
    orderByField.get(String(r.field_label ?? "").trim().toLowerCase()) ??
    Number.MAX_SAFE_INTEGER;

  const dealByTask = new Map<string, string>(
    infoTasks.map((t) => [t.id as string, (t.deal_id as string) ?? ""]),
  );
  const known = new Set(leadIds);

  const grouped = new Map<string, Array<{ row: ClerkInfoRow; order: number }>>();
  for (const r of responses ?? []) {
    if (r.field_type === "file") continue;
    const value = String(r.value ?? "").trim();
    if (!value) continue;
    const leadId = leadByDeal.get(dealByTask.get(r.task_id as string) ?? "") ?? "";
    if (!known.has(leadId)) continue;
    grouped.set(leadId, [
      ...(grouped.get(leadId) ?? []),
      {
        row: { label: String(r.field_label ?? r.field_id ?? "Field"), value },
        order: orderOf(r),
      },
    ]);
  }

  for (const [leadId, rows] of grouped) {
    byLead.set(
      leadId,
      rows
        .sort((a, b) => a.order - b.order || a.row.label.localeCompare(b.row.label))
        .map((r) => r.row),
    );
  }
  return byLead;
}

/**
 * Build the file's combined identification and personal-information PDFs.
 *
 * Best-effort by contract, like everything else on the clerk-email path: any
 * query or blob that fails costs that one document, never the send. On a total
 * failure this returns the empty result and the caller falls back to attaching
 * everything separately — exactly what it did before merging existed.
 *
 * @param people every party on the file, primary first — the order they appear in
 */
export async function buildCombinedClerkDocs(params: {
  dealIds: string[];
  people: ClerkPerson[];
  fileNumber: string;
}): Promise<CombinedClerkDocs> {
  const { dealIds, people, fileNumber } = params;
  const leadIds = people.map((p) => p.leadId).filter(Boolean);
  if (leadIds.length === 0) return EMPTY;

  const consumedUrls = new Set<string>();
  const attachments: EmailAttachment[] = [];
  let identificationDocs = 0;
  let personalInfoPeople = 0;
  let bytes = 0;

  const stem = fileNumber ? `${fileNumber} - ` : "";

  try {
    const docsByLead = await loadIdentificationDocs(leadIds, dealIds);
    const merged = await renderIdentificationPdf({
      people,
      docsByLead,
      fileNumber,
      fetchBytes: downloadDoc,
    });
    if (merged) {
      for (const url of merged.consumedUrls) consumedUrls.add(url);
      for (const note of merged.skipped) {
        logger.warn(`[ClerkCombined] ID left out of the merged PDF — ${note}`);
      }
      attachments.push({
        filename: `${stem}Identification.pdf`,
        content: Buffer.from(merged.bytes),
      });
      identificationDocs = merged.count;
      bytes += merged.bytes.byteLength;
    }
  } catch (err) {
    // The individual documents are still attached separately — consumedUrls is
    // only added to once a document is genuinely inside the merged PDF.
    logger.error("[ClerkCombined] identification merge failed:", err);
  }

  try {
    const rowsByLead = await loadPersonalInfo(leadIds, dealIds);
    const merged = await renderPersonalInfoPdf({ people, rowsByLead, fileNumber });
    if (merged) {
      attachments.push({
        filename: `${stem}Personal Information.pdf`,
        content: Buffer.from(merged.bytes),
      });
      personalInfoPeople = merged.count;
      bytes += merged.bytes.byteLength;
    }
  } catch (err) {
    logger.error("[ClerkCombined] personal information merge failed:", err);
  }

  return { attachments, consumedUrls, identificationDocs, personalInfoPeople, bytes };
}
