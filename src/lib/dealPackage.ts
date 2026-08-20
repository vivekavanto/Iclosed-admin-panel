// The deal document package — ONE enumeration, ONE grouping, used by both
// "Download All" (a ZIP of these entries) and "Email to Clerk" (the same entries
// as attachments).
//
// Why this exists
// ───────────────
// The two exports used to enumerate documents separately: the ZIP was assembled
// in the browser from React state matched to tasks by id/template/title, while
// the clerk email read the three document tables directly on the server. A
// document the client-side matcher couldn't place — a lead_corporate_docs row
// with no task_id whose stored title no longer matches its task, which is what a
// "Notice of Fulfillment of Condition" is — was silently missing from the ZIP
// while arriving perfectly well on the email. Deriving both from this module
// makes that class of bug structurally impossible: if a blob is on the file, it
// is in the package.
//
// Grouping
// ────────
//   1. Identification      — every party's ID, merged. A pure merge: no divider
//                            pages, and blank pages inside a two-sided scan are
//                            dropped (see packagePdf.isBlankPage).
//   2. Personal Information — every party's answers, merged.
//   3. One entry per TASK   — its answers, then every file uploaded against it
//                            merged in behind them. This is what makes a
//                            multi-file void cheque or property tax bill arrive
//                            as one PDF instead of three attachments.
//   4. One entry per orphan document — a stored document belonging to no task,
//                            grouped by its type and owner so it still ships.
//
// Everything is best-effort: a blob that can't be fetched or embedded costs that
// one document (and is reported in `skipped`, so the clerk email can attach the
// original instead), never the package.

import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { downloadDoc } from "./familyDocuments";
import {
  PackageDoc,
  MAIL_FORWARDING_HEADING,
  startsMailForwarding,
  type PackageDealMeta,
  type SkippedDoc,
} from "./packagePdf";
import { logger } from "./logger";

export interface PackagePerson {
  leadId: string;
  dealId: string | null;
  name: string;
}

/** One PDF in the package. */
export interface PackageEntry {
  /** File-name stem — "Identification", "Latest Property Tax Bill - Aliya Test". */
  title: string;
  bytes: Uint8Array;
  /** Source documents merged in. */
  documents: number;
  /** Blob URLs whose content genuinely reached this PDF. */
  consumedUrls: string[];
}

/** A document that could not go into a PDF, kept in its original bytes. */
export interface PackageOriginal {
  fileName: string;
  bytes: Uint8Array;
}

export interface DealPackageResult {
  meta: PackageDealMeta;
  fileNumber: string;
  people: PackagePerson[];
  entries: PackageEntry[];
  /** Unembeddable documents (HEIC, Office files) in their original form. */
  originals: PackageOriginal[];
  /** Every blob that reached one of the entries. */
  consumedUrls: Set<string>;
  /** Documents that could not be embedded — attach the originals instead. */
  skipped: SkippedDoc[];
  /** Names of documents whose blob could not be downloaded at all. */
  failed: string[];
  /** ID documents inside the identification entry. */
  identificationDocs: number;
  /** Parties inside the personal-information entry. */
  personalInfoPeople: number;
}

interface TaskRow {
  id: string;
  deal_id: string;
  title: string;
  milestone_id: string | null;
  order_index: number | null;
  task_template_id: string | null;
}

interface ResponseRow {
  task_id: string;
  field_id: string | null;
  field_label: string | null;
  field_type: string | null;
  value: string | null;
  file_url: string | null;
  file_name: string | null;
}

const MAX_INT = Number.MAX_SAFE_INTEGER;

function fullName(l: { first_name?: string | null; last_name?: string | null }): string {
  return `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim();
}

/** "property_tax_bill" → "Property Tax Bill". */
function humanise(value: string | null | undefined, fallback: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strip characters a ZIP entry or an email attachment shouldn't carry. */
export function sanitizeEntryName(name: string): string {
  return (
    String(name ?? "")
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Document"
  );
}

/**
 * Build every PDF in the file's document package.
 *
 * Returns null when the deal doesn't exist. An existing deal with nothing
 * uploaded returns a result with no entries — the caller decides whether that is
 * an error (the clerk email) or a toast (the ZIP).
 */
export async function buildDealPackage(dealId: string): Promise<DealPackageResult | null> {
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select(
      "id, lead_id, file_number, type, status, closing_date, price, property_address, selling_property_address",
    )
    .eq("id", dealId)
    .maybeSingle();
  if (!deal) return null;

  const { data: primaryLead } = deal.lead_id
    ? await supabaseAdmin
        .from("leads")
        .select("id, first_name, last_name, parent_lead_id, lead_type")
        .eq("id", deal.lead_id)
        .maybeSingle()
    : { data: null };

  // Whole family, so a co-purchaser's documents travel with the primary's.
  const familyDealIds = await getFamilyDealIds(dealId);
  const dealIds = Array.from(new Set([...familyDealIds, dealId]));

  const rootLeadId = primaryLead?.parent_lead_id ?? primaryLead?.id ?? null;
  const { data: familyLeads } = rootLeadId
    ? await supabaseAdmin
        .from("leads")
        .select("id, first_name, last_name, parent_lead_id")
        .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
        .eq("is_deleted", false)
    : { data: null };

  const coParties = (familyLeads ?? []).filter((l) => l.id !== primaryLead?.id);
  const leadIds = [
    ...(primaryLead ? [primaryLead.id as string] : []),
    ...coParties.map((l) => l.id as string),
  ];

  const fileNumber = (deal.file_number as string) ?? "";
  const meta: PackageDealMeta = {
    fileNumber,
    type: deal.type as string | null,
    status: deal.status as string | null,
    propertyAddress: deal.property_address as string | null,
    sellingPropertyAddress: deal.selling_property_address as string | null,
    closingDate: deal.closing_date ? String(deal.closing_date) : null,
    price: deal.price as number | null,
  };

  const [{ data: tasks }, { data: milestones }, { data: dealRows }, { data: corporate }] =
    await Promise.all([
      dealIds.length
        ? supabaseAdmin
            .from("tasks")
            .select("id, deal_id, title, milestone_id, order_index, task_template_id")
            .in("deal_id", dealIds)
            .eq("is_deleted", false)
        : Promise.resolve({ data: [] }),
      dealIds.length
        ? supabaseAdmin
            .from("milestones")
            .select("id, deal_id, title, order_index")
            .in("deal_id", dealIds)
        : Promise.resolve({ data: [] }),
      dealIds.length
        ? supabaseAdmin.from("deals").select("id, lead_id").in("id", dealIds)
        : Promise.resolve({ data: [] }),
      leadIds.length
        ? supabaseAdmin
            .from("lead_corporate_docs")
            .select("lead_id, file_url, file_name, doc_type, custom_type, task_title, created_at")
            .in("lead_id", leadIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [] }),
    ]);

  const taskRows = (tasks ?? []) as unknown as TaskRow[];
  const { data: responses } = taskRows.length
    ? await supabaseAdmin
        .from("task_responses")
        .select("task_id, field_id, field_label, field_type, value, file_url, file_name")
        .in(
          "task_id",
          taskRows.map((t) => t.id),
        )
    : { data: [] };
  const responseRows = (responses ?? []) as unknown as ResponseRow[];

  // Field ordering, so a task's answers print in the order the client was asked.
  const templateIds = Array.from(
    new Set(taskRows.map((t) => t.task_template_id).filter(Boolean)),
  ) as string[];
  const { data: fields } = templateIds.length
    ? await supabaseAdmin
        .from("task_form_fields")
        .select("id, label, order_index, task_template_id")
        .in("task_template_id", templateIds)
    : { data: [] };

  const orderByField = new Map<string, number>();
  (fields ?? []).forEach((f, i) => {
    const order = Number(f.order_index ?? i);
    if (f.id) orderByField.set(String(f.id), order);
    const label = String(f.label ?? "").trim().toLowerCase();
    if (label && !orderByField.has(label)) orderByField.set(label, order);
  });
  const fieldOrder = (r: ResponseRow) =>
    (r.field_id ? orderByField.get(String(r.field_id)) : undefined) ??
    orderByField.get(String(r.field_label ?? "").trim().toLowerCase()) ??
    MAX_INT;

  const leadNameById = new Map<string, string>(
    [...(primaryLead ? [primaryLead] : []), ...coParties].map((l) => [
      l.id as string,
      fullName(l),
    ]),
  );
  const leadByDeal = new Map<string, string>(
    (dealRows ?? []).map((d) => [d.id as string, (d.lead_id as string) ?? ""]),
  );
  const people: PackagePerson[] = leadIds.map((leadId) => ({
    leadId,
    dealId:
      (dealRows ?? []).find((d) => (d.lead_id as string) === leadId)?.id as string | undefined ??
      null,
    name: leadNameById.get(leadId) ?? "",
  }));
  // Family order, primary first — the order parties appear inside every entry.
  const personRank = new Map<string, number>(people.map((p, i) => [p.leadId, i]));

  const milestoneOrder = new Map<string, number>(
    (milestones ?? []).map((m) => [m.id as string, Number(m.order_index ?? MAX_INT)]),
  );

  const entries: PackageEntry[] = [];
  const consumedUrls = new Set<string>();
  const skipped: SkippedDoc[] = [];
  const failed: string[] = [];
  let identificationDocs = 0;
  let personalInfoPeople = 0;

  /** Fetch a blob once; a failure is recorded and costs only that document. */
  const bytesCache = new Map<string, Uint8Array | null>();
  const fetchBytes = async (fileUrl: string, fileName: string): Promise<Uint8Array | null> => {
    if (bytesCache.has(fileUrl)) return bytesCache.get(fileUrl) ?? null;
    try {
      const buf = await downloadDoc(fileUrl);
      const bytes = new Uint8Array(buf);
      bytesCache.set(fileUrl, bytes);
      return bytes;
    } catch (err) {
      logger.warn(
        `[dealPackage] could not download ${fileName}: ${err instanceof Error ? err.message : err}`,
      );
      bytesCache.set(fileUrl, null);
      failed.push(fileName);
      skipped.push({
        fileUrl,
        fileName,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  /** Finish a PackageDoc into an entry, dropping it when nothing was drawn. */
  const finish = async (title: string, pdf: PackageDoc): Promise<void> => {
    const bytes = await pdf.save();
    skipped.push(...pdf.skipped);
    // packagePdf is deliberately logger-free, so its complaints surface here.
    for (const warning of pdf.warnings) {
      logger.warn(`[dealPackage] "${title}": ${warning}`);
    }
    for (const doc of pdf.skipped) {
      logger.warn(`[dealPackage] "${title}" left out ${doc.fileName} — ${doc.reason}`);
    }
    if (!bytes) return;
    for (const url of pdf.consumedUrls) consumedUrls.add(url);
    entries.push({
      title: sanitizeEntryName(title),
      bytes,
      documents: pdf.documents,
      consumedUrls: [...pdf.consumedUrls],
    });
  };

  // ── 1. Identification ──────────────────────────────────────────────────────
  // A pure merge, by request: no per-person divider pages. An uploaded PDF's
  // pages are copied in verbatim (blank ones dropped) and an image gets its own
  // page whose band names the party, so attribution survives without a page of
  // its own.
  try {
    const docsByLead = await loadIdentificationDocs(leadIds, dealIds);
    const idPdf = await PackageDoc.create(meta);
    for (const person of people) {
      const docs = docsByLead.get(person.leadId) ?? [];
      let index = 0;
      for (const doc of docs) {
        index++;
        const fileName = doc.fileName || "Identification";
        const bytes = await fetchBytes(doc.fileUrl, fileName);
        if (!bytes) continue;
        await idPdf.addDocument({
          bytes,
          fileUrl: doc.fileUrl,
          fileName,
          heading: person.name || "Client",
          sublabel: doc.label || formatIdLabel(null),
          index,
          total: docs.length,
          sectionTitle: "Identification",
        });
      }
    }
    identificationDocs = idPdf.documents;
    await finish("Identification", idPdf);
  } catch (err) {
    logger.error("[dealPackage] identification entry failed:", err);
  }

  // ── 2. Personal Information ────────────────────────────────────────────────
  try {
    const rowsByLead = await loadPersonalInfo(leadIds, dealIds);
    const withRows = people.filter((p) => (rowsByLead.get(p.leadId) ?? []).length > 0);
    if (withRows.length > 0) {
      const infoPdf = await PackageDoc.create(meta);
      for (const person of withRows) {
        infoPdf.newPage();
        infoPdf.band(person.name || "Client", "Personal Information");
        if (person.name) infoPdf.kvRow("Name", person.name);
        for (const row of rowsByLead.get(person.leadId) ?? []) {
          infoPdf.kvRow(
            row.label,
            row.value,
            startsMailForwarding(row.label) ? MAIL_FORWARDING_HEADING : undefined,
          );
        }
      }
      personalInfoPeople = withRows.length;
      await finish("Personal Information", infoPdf);
    }
  } catch (err) {
    logger.error("[dealPackage] personal information entry failed:", err);
  }

  // ── 3. One entry per task ──────────────────────────────────────────────────
  // Deal-page order: milestone order, then task order within it, with each
  // person's copy of a task kept beside the primary's.
  const responsesByTask = new Map<string, ResponseRow[]>();
  for (const r of responseRows) {
    responsesByTask.set(r.task_id, [...(responsesByTask.get(r.task_id) ?? []), r]);
  }

  const packagedTasks = taskRows.filter(
    (t) => !isIdentificationTitle(t.title) && !isPersonalInfoTitle(t.title),
  );
  // What a task is a copy OF — template id when there is one, its title
  // otherwise, so a manually-added twin still pairs up with its peer.
  const peerKey = (t: TaskRow) =>
    t.task_template_id ?? `title:${String(t.title ?? "").toLowerCase().trim()}`;
  const rankOf = (t: TaskRow) => personRank.get(leadByDeal.get(t.deal_id) ?? "") ?? MAX_INT;

  const ordered = [...packagedTasks].sort(
    (a, b) =>
      (milestoneOrder.get(a.milestone_id ?? "") ?? MAX_INT) -
        (milestoneOrder.get(b.milestone_id ?? "") ?? MAX_INT) ||
      Number(a.order_index ?? MAX_INT) - Number(b.order_index ?? MAX_INT) ||
      String(a.title).localeCompare(String(b.title)) ||
      rankOf(a) - rankOf(b),
  );

  // The person's name goes in the entry's name only when more than one party
  // carries that task — which is what makes "Mortgage Details - Ravi Anand" and
  // "Mortgage Details - Preetha Jayanthan" a matched pair, while a task only one
  // person carries stays plain.
  const copies = new Map<string, number>();
  for (const t of ordered) copies.set(peerKey(t), (copies.get(peerKey(t)) ?? 0) + 1);

  for (const task of ordered) {
    const rows = responsesByTask.get(task.id) ?? [];
    const fileRows = rows.filter((r) => r.field_type === "file" && r.file_url);
    const textRows = rows
      .filter((r) => r.field_type !== "file" && String(r.value ?? "").trim())
      .sort((a, b) => fieldOrder(a) - fieldOrder(b));
    if (fileRows.length === 0 && textRows.length === 0) continue;

    const ownerName = leadNameById.get(leadByDeal.get(task.deal_id) ?? "") ?? "";
    const title = String(task.title ?? "Task");

    try {
      const pdf = await PackageDoc.create(meta);
      // Only the ANSWERS earn an info block. A task that is purely an upload
      // would otherwise open with an empty table in front of the document the
      // clerk actually wants.
      if (textRows.length > 0) {
        pdf.newPage();
        pdf.band(ownerName || title, ownerName ? title : undefined);
        if (ownerName) pdf.kvRow("Name", ownerName);
        for (const r of textRows) {
          const label = String(r.field_label || r.field_id || "Field");
          pdf.kvRow(
            label,
            String(r.value ?? "").trim() || "—",
            startsMailForwarding(label) ? MAIL_FORWARDING_HEADING : undefined,
          );
        }
      }

      // Every file uploaded against this task, merged in behind the answers —
      // one PDF for the whole task however many files it holds.
      let index = 0;
      for (const r of fileRows) {
        index++;
        const fileName = r.file_name || r.field_label || "Document";
        const bytes = await fetchBytes(r.file_url as string, fileName);
        if (!bytes) continue;
        await pdf.addDocument({
          bytes,
          fileUrl: r.file_url as string,
          fileName,
          heading: ownerName || title,
          sublabel: r.field_label || r.file_name || title,
          index,
          total: fileRows.length,
          sectionTitle: title,
        });
      }

      const named =
        (copies.get(peerKey(task)) ?? 1) > 1 && ownerName ? `${title} - ${ownerName}` : title;
      await finish(named, pdf);
    } catch (err) {
      logger.error(`[dealPackage] task entry "${title}" failed:`, err);
      failed.push(title);
    }
  }

  // ── 4. Leftover documents ──────────────────────────────────────────────────
  // Any stored blob that reached no entry above. This is the safety net the ZIP
  // never had: whatever the matching rules do or don't manage to place, a
  // document on this file ends up in the package.
  //
  // Both stores are swept. lead_corporate_docs rows with no owning task are the
  // obvious case — a "Notice of Fulfillment of Condition" filed against the file
  // rather than a task. But task_responses needs sweeping too: a file uploaded
  // against the identification or personal-information task is skipped by the
  // per-task loop above (those two merge across the family instead), and without
  // this it would have nowhere else to go.
  const taskById = new Map(taskRows.map((t) => [t.id, t]));
  interface Leftover {
    fileUrl: string;
    fileName: string;
    owner: string;
    label: string;
  }
  const leftovers: Leftover[] = [];

  for (const d of corporate ?? []) {
    const url = d.file_url as string | null;
    if (!url || consumedUrls.has(url)) continue;
    // An ID that couldn't be embedded already has its say inside the
    // identification entry; a second copy here would only duplicate it.
    if (String(d.doc_type ?? "").toLowerCase() === "identification") continue;
    leftovers.push({
      fileUrl: url,
      fileName: (d.file_name as string) || "Document",
      owner: leadNameById.get(d.lead_id as string) ?? "",
      label: humanise(
        (d.task_title as string) || (d.custom_type as string) || (d.doc_type as string),
        "Document",
      ),
    });
  }

  for (const r of responseRows) {
    if (r.field_type !== "file" || !r.file_url || consumedUrls.has(r.file_url)) continue;
    const task = taskById.get(r.task_id);
    // Whatever couldn't be embedded into the identification entry stays there.
    if (task && isIdentificationTitle(task.title)) continue;
    leftovers.push({
      fileUrl: r.file_url,
      fileName: r.file_name || r.field_label || "Document",
      owner: task ? leadNameById.get(leadByDeal.get(task.deal_id) ?? "") ?? "" : "",
      label: humanise(task?.title || r.field_label, "Document"),
    });
  }

  // Grouped by owner + label, so three pages of one tax bill are one PDF.
  const groups = new Map<string, { title: string; docs: Leftover[] }>();
  const seenLeftover = new Set<string>();
  for (const d of leftovers) {
    if (seenLeftover.has(d.fileUrl)) continue;
    seenLeftover.add(d.fileUrl);
    const key = `${d.label}::${d.owner}`;
    const existing = groups.get(key);
    if (existing) existing.docs.push(d);
    else {
      groups.set(key, {
        title: d.owner && people.length > 1 ? `${d.label} - ${d.owner}` : d.label,
        docs: [d],
      });
    }
  }

  for (const { title, docs } of groups.values()) {
    try {
      const pdf = await PackageDoc.create(meta);
      let index = 0;
      for (const d of docs) {
        index++;
        const bytes = await fetchBytes(d.fileUrl, d.fileName);
        if (!bytes) continue;
        await pdf.addDocument({
          bytes,
          fileUrl: d.fileUrl,
          fileName: d.fileName,
          heading: d.owner || title,
          sublabel: title,
          index,
          total: docs.length,
          sectionTitle: title,
        });
      }
      await finish(title, pdf);
    } catch (err) {
      logger.error(`[dealPackage] leftover entry "${title}" failed:`, err);
      failed.push(title);
    }
  }

  // Anything that could not go INTO a PDF — a HEIC ID, a Word document — but
  // whose bytes we do hold. The ZIP ships these in their original form so the
  // archive is genuinely complete; the clerk email attaches them separately for
  // the same reason.
  const originals: PackageOriginal[] = [];
  const seenOriginal = new Set<string>();
  for (const doc of skipped) {
    if (seenOriginal.has(doc.fileUrl)) continue;
    const bytes = bytesCache.get(doc.fileUrl);
    if (!bytes) continue; // never downloaded — it's in `failed` instead
    seenOriginal.add(doc.fileUrl);
    originals.push({ fileName: sanitizeEntryName(doc.fileName), bytes });
  }

  return {
    meta,
    fileNumber,
    people,
    entries,
    originals,
    consumedUrls,
    skipped,
    failed,
    identificationDocs,
    personalInfoPeople,
  };
}

/**
 * Name an entry the way the firm files it: numbered so a file explorer lists
 * them in deal-page order, and carrying the file number because these get
 * dragged around individually.
 */
export function entryFileName(fileNumber: string, index: number, title: string): string {
  return `${String(index).padStart(2, "0")} ${sanitizeEntryName(
    [fileNumber, title].filter(Boolean).join(" - "),
  )}.pdf`;
}

// ───────────────────────── the two family-wide loaders ─────────────────────────
//
// Identification and personal information are the two things that merge ACROSS
// the family rather than per task, so they are gathered per LEAD rather than per
// task. Every store is consulted for the same reason the sweep above consults
// them: "Save draft", "Replace" and "Clone from previous deal" write only to
// lead_corporate_docs, while a client answering the task writes only to
// task_responses. Reading one of them alone loses somebody's ID.

/** An identification document belonging to one party. */
interface PackageIdDoc {
  leadId: string;
  fileUrl: string;
  fileName: string;
  /** "Driver's Licence" / "Passport" — captioned onto the page. */
  label: string;
}

/** One answer on the personal-information form. */
interface PackageInfoRow {
  label: string;
  value: string;
}

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
): Promise<Map<string, PackageIdDoc[]>> {
  const byLead = new Map<string, PackageIdDoc[]>();
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
  const push = (doc: PackageIdDoc) => {
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
): Promise<Map<string, PackageInfoRow[]>> {
  const byLead = new Map<string, PackageInfoRow[]>();
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

  const grouped = new Map<string, Array<{ row: PackageInfoRow; order: number }>>();
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
