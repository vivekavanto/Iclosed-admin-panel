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
//   2. Agreement of Purchase and Sale — the file's agreement(s), merged. One PDF
//                            per FILE: a P&S file carries a purchase-side and a
//                            sale-side agreement and every party's deal holds
//                            its own copy of the APS task, which had the clerks
//                            opening the same agreement three or four times.
//   3. Personal Information — every party's answers, merged.
//   4. Property Information — facts about the PROPERTY rather than a person:
//                            the lock box code and the rental equipment on it.
//                            Both were reported missing: the lock box code
//                            because it lives in a column on the deal that no
//                            task or document carries, the rental answers
//                            because they sit on the Sale-side shared task.
//   5. One entry per TASK   — its answers, then every file uploaded against it
//                            merged in behind them. This is what makes a
//                            multi-file void cheque or property tax bill arrive
//                            as one PDF instead of three attachments.
//   6. One entry per orphan document — a stored document belonging to no task,
//                            grouped by its type and owner so it still ships.
//                            This sweeps ALL FIVE stores a blob can sit in:
//                            lead_corporate_docs, lead_identification_docs,
//                            task_responses, tasks.document_url and
//                            deal_documents.
//
// Merging is OPTIONAL — see DealPackageOptions.mergeDocuments
// ───────────────────────────────────────────────
// The grouping above is what "Download All" ships. "Email to Clerk" asks for the
// same enumeration with `mergeDocuments: false`: sections 1, 2 and 6 then draw
// nothing and drop out, sections 3, 4 and 5 keep their generated ANSWERS and
// nothing else, and every uploaded document stays unconsumed so the caller can
// attach it on its own, in the bytes and under the name it was uploaded with.
// The enumeration is shared either way — only the packaging differs.
//
// Everything is best-effort: a blob that can't be fetched or embedded costs that
// one document (and is reported in `skipped`, so the clerk email can attach the
// original instead), never the package.

import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { downloadDoc } from "./familyDocuments";
import { sanitizeEntryName } from "./packageAttachments";
import {
  PackageDoc,
  MAIL_FORWARDING_HEADING,
  startsMailForwarding,
  type PackageDealMeta,
  type SkippedDoc,
} from "./packagePdf";
import { logger } from "./logger";

// sanitizeEntryName and the rules for packing these entries onto an email live in
// ./packageAttachments — a dependency-free module, so tests can pin them without
// loading Supabase, the blob store or the PDF builder. Re-exported here because
// the ZIP route has always imported it from this module.
export { sanitizeEntryName };

export interface PackagePerson {
  leadId: string;
  dealId: string | null;
  name: string;
}

/**
 * Which part of the package an entry belongs to. Callers group by this rather
 * than by matching on the title — the clerk email's "Attached:" breakdown used
 * to compare `entry.title` against the two literal strings "Identification" and
 * "Personal Information", which silently miscounts the moment a combined PDF is
 * added or renamed.
 */
export type PackageEntryKind =
  | "identification"
  | "aps"
  | "personal-info"
  | "property"
  | "task"
  | "leftover";

/** One PDF in the package. */
export interface PackageEntry {
  /** File-name stem — "Identification", "Latest Property Tax Bill - Aliya Test". */
  title: string;
  kind: PackageEntryKind;
  bytes: Uint8Array;
  /** Source documents merged in. */
  documents: number;
  /** Blob URLs whose content genuinely reached this PDF. */
  consumedUrls: string[];
}

/** How the package is assembled. */
export interface DealPackageOptions {
  /**
   * Merge each section's source documents into that section's PDF — the ZIP's
   * behaviour, and the default.
   *
   * Pass `false` to leave every uploaded document ALONE. The entries then hold
   * only the generated answers (personal information, property facts, a task's
   * form responses), no blob is reported in `consumedUrls`, and the caller
   * ships each document as its own attachment in its original bytes. That is
   * what "Email to Clerk" does: merging costs a document its filename and its
   * byte-for-byte formatting, and the clerks asked for the originals back.
   */
  mergeDocuments?: boolean;
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
  /** Agreements merged into the combined APS entry. */
  apsDocs: number;
  /** Parties inside the personal-information entry. */
  personalInfoPeople: number;
  /** Facts (lock box code, rental answers) inside the property entry. */
  propertyInfoRows: number;
  /** Whether source documents were merged into the entries — see the options. */
  mergedDocuments: boolean;
}

interface TaskRow {
  id: string;
  deal_id: string;
  title: string;
  milestone_id: string | null;
  order_index: number | null;
  task_template_id: string | null;
  /** A document hung off the TASK itself rather than off one of its form fields. */
  document_url: string | null;
  document_name: string | null;
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

/**
 * Build every PDF in the file's document package.
 *
 * Returns null when the deal doesn't exist. An existing deal with nothing
 * uploaded returns a result with no entries — the caller decides whether that is
 * an error (the clerk email) or a toast (the ZIP).
 *
 * `options.mergeDocuments: false` builds the SAME enumeration without merging
 * anything: the entries carry the generated answers only, and every uploaded
 * document is left for the caller to attach untouched.
 */
export async function buildDealPackage(
  dealId: string,
  options: DealPackageOptions = {},
): Promise<DealPackageResult | null> {
  // Default ON, so "Download All" keeps building the merged archive. The clerk
  // email opts out — every document reaches the clerks under its own name.
  const mergeDocuments = options.mergeDocuments !== false;
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

  const [
    { data: tasks },
    { data: milestones },
    { data: dealRows },
    { data: corporate, error: corporateError },
  ] = await Promise.all([
      dealIds.length
        ? supabaseAdmin
            .from("tasks")
            .select(
              // document_url / document_name: a document attached to the task
              // itself, which the deal page renders and which NO sweep here used
              // to look at. Free — it rides on a query already being made.
              "id, deal_id, title, milestone_id, order_index, task_template_id, document_url, document_name",
            )
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
        ? supabaseAdmin
            .from("deals")
            // lockbox_code / garage_access_code are per-deal columns with no task
            // or document behind them — section 4 is the only thing that ships
            // them, so they have to be read for the whole family here.
            .select("id, lead_id, file_number, property_address, lockbox_code, garage_access_code")
            .in("id", dealIds)
        : Promise.resolve({ data: [], error: null }),
      leadIds.length
        ? supabaseAdmin
            .from("lead_corporate_docs")
            // NO task_title — that column does not exist on this table (it is
            // synthesised by /api/admin/deals/[id]/documents). Selecting it made
            // PostgREST reject the whole query with 42703, which cost the package
            // its ENTIRE lead_corporate_docs sweep: every document filed against
            // the file rather than a task — intake APS uploads, a Notice of
            // Fulfillment, a retainer — was silently absent from both the ZIP and
            // the clerk email. Anything added here must exist on the table.
            .select("lead_id, file_url, file_name, doc_type, custom_type, document_type, created_at")
            .in("lead_id", leadIds)
            .order("created_at", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
    ]);

  // A rejected sweep must never be silent again: an empty `corporate` is
  // indistinguishable from "this file has no filed documents" at the call sites
  // below, so say so here.
  if (corporateError) {
    logger.error(
      `[dealPackage] lead_corporate_docs sweep failed — filed documents are MISSING from this package:`,
      corporateError,
    );
  }

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

  // ── task_responses.file_url is NOT reliable ────────────────────────────────
  // A file response routinely carries a file_name with a NULL file_url: the
  // blob is on the matching lead_corporate_docs row instead (the customer
  // portal writes both stores, and a re-submit deletes and re-inserts the
  // response rows while the document rows survive). BOTH admin document views
  // repair this at read time — see the two "Resolve missing file URLs from
  // lead_corporate_docs" blocks in /api/admin/task-responses — which is why the
  // deal page shows a document the package cannot see.
  //
  // Repairing it here, once, fixes every section below at the same time rather
  // than leaving each one to remember: filtering on `r.file_url` alone silently
  // drops a document the firm knows it has.
  const corporateUrlByName = new Map<string, string>();
  for (const d of corporate ?? []) {
    const name = String(d.file_name ?? "").trim().toLowerCase();
    const url = (d.file_url as string | null) ?? "";
    if (name && url && !corporateUrlByName.has(name)) corporateUrlByName.set(name, url);
  }
  let repairedUrls = 0;
  const unresolvedFileRows: string[] = [];
  for (const r of responseRows) {
    if (r.field_type !== "file" || r.file_url) continue;
    const url = corporateUrlByName.get(String(r.file_name ?? "").trim().toLowerCase());
    if (url) {
      r.file_url = url;
      repairedUrls++;
    } else if (r.file_name) {
      unresolvedFileRows.push(r.file_name);
    }
  }
  if (repairedUrls > 0) {
    logger.warn(
      `[dealPackage] resolved ${repairedUrls} task_responses file row(s) with a null file_url from lead_corporate_docs`,
    );
  }
  if (unresolvedFileRows.length > 0) {
    logger.error(
      `[dealPackage] ${unresolvedFileRows.length} uploaded file(s) have no blob anywhere and are MISSING from this package: ${unresolvedFileRows.join(", ")}`,
    );
  }

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
  // A file response whose blob could not be resolved at all is already lost —
  // report it the same way a failed download is, so the caller can warn.
  const failed: string[] = [...unresolvedFileRows];
  let identificationDocs = 0;
  let apsDocs = 0;
  let personalInfoPeople = 0;
  let propertyInfoRows = 0;

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

  /**
   * The documents a section should merge in — empty when the caller asked for
   * documents to stay separate.
   *
   * Every section funnels its source documents through this rather than testing
   * `mergeDocuments` itself, so "don't merge" cannot be half-applied: nothing is
   * downloaded, nothing is embedded, and nothing lands in `consumedUrls` — which
   * is exactly what makes the blob reach the caller as its own attachment.
   */
  const toMerge = <T>(docs: T[]): T[] => (mergeDocuments ? docs : []);

  /** Finish a PackageDoc into an entry, dropping it when nothing was drawn. */
  const finish = async (
    title: string,
    pdf: PackageDoc,
    kind: PackageEntryKind,
  ): Promise<void> => {
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
      kind,
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
  //
  // With merging off this section has nothing to draw and drops out entirely —
  // each ID travels to the clerk as its own attachment instead.
  try {
    const docsByLead = await loadIdentificationDocs(leadIds, dealIds);
    const idPdf = await PackageDoc.create(meta);
    for (const person of people) {
      const docs = toMerge(docsByLead.get(person.leadId) ?? []);
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
    await finish("Identification", idPdf, "identification");
  } catch (err) {
    logger.error("[dealPackage] identification entry failed:", err);
  }

  // ── 2. Agreement of Purchase and Sale ──────────────────────────────────────
  // Merged exactly the way identification is, and for the same reason. The APS
  // reaches us from two directions — bridged onto the APS task as a
  // task_response by completeApsTask, or filed straight onto the lead as a
  // lead_corporate_docs row at intake — and a P&S family multiplies it further:
  // one APS task per side, per party's deal. That was three or four attachments
  // of the same agreement; it is now one PDF for the file, deduped by blob URL.
  try {
    const aps = await loadApsMaterial(leadIds, dealIds);
    if (aps.docs.length > 0 || aps.answers.length > 0) {
      const apsPdf = await PackageDoc.create(meta);

      // Any answers typed ON the APS task (most decks have none — it is an
      // upload task) lead, so the agreements that follow stay contiguous.
      if (aps.answers.length > 0) {
        apsPdf.newPage();
        apsPdf.band("Agreement of Purchase and Sale", "Details");
        let heading = "";
        for (const row of aps.answers) {
          const owner = leadNameById.get(row.leadId) ?? "";
          const showHeading = owner && owner !== heading ? owner : undefined;
          if (showHeading) heading = owner;
          apsPdf.kvRow(row.label, row.value, showHeading);
        }
      }

      let index = 0;
      for (const doc of toMerge(aps.docs)) {
        index++;
        const fileName = doc.fileName || "Agreement of Purchase and Sale";
        const bytes = await fetchBytes(doc.fileUrl, fileName);
        if (!bytes) continue;
        await apsPdf.addDocument({
          bytes,
          fileUrl: doc.fileUrl,
          fileName,
          heading: leadNameById.get(doc.leadId) || "Agreement of Purchase and Sale",
          // The side is what a clerk on a P&S file is looking for — "Purchase" /
          // "Sale" — so it captions the page ahead of the upload's own name.
          sublabel: doc.label || "Agreement",
          index,
          total: aps.docs.length,
          sectionTitle: "Agreement of Purchase and Sale",
        });
      }

      apsDocs = apsPdf.documents;
      await finish("Agreement of Purchase and Sale", apsPdf, "aps");
    }
  } catch (err) {
    logger.error("[dealPackage] agreement of purchase and sale entry failed:", err);
  }

  // ── 3. Personal Information ────────────────────────────────────────────────
  try {
    const rowsByLead = await loadPersonalInfo(leadIds, dealIds);
    const withRows = people.filter((p) => (rowsByLead.get(p.leadId) ?? []).length > 0);
    if (withRows.length > 0) {
      const infoPdf = await PackageDoc.create(meta);
      for (const person of withRows) {
        // section(), NOT newPage(): a party's answers start wherever the last
        // party's ended. Forcing a page each meant a two-person file was two
        // pages that were each ~80% white.
        infoPdf.section(person.name || "Client", "Personal Information");
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
      await finish("Personal Information", infoPdf, "personal-info");
    }
  } catch (err) {
    logger.error("[dealPackage] personal information entry failed:", err);
  }

  const responsesByTask = new Map<string, ResponseRow[]>();
  for (const r of responseRows) {
    responsesByTask.set(r.task_id, [...(responsesByTask.get(r.task_id) ?? []), r]);
  }

  // ── 4. Property Information ────────────────────────────────────────────────
  // What the clerks reported missing. Neither fact is a document, which is
  // exactly why a document package lost them:
  //
  //   • The LOCK BOX CODE is a column on the deal (deals.lockbox_code, typed
  //     into the card on the deal page, and the source of the
  //     {{ lockbox_code }} email variable). Some files instead carry it as the
  //     answer to an "Enter Lockbox Code" task. Both are read here, so the code
  //     lands in one predictable place however it was entered — and the task is
  //     dropped from the per-task loop below rather than shipping twice.
  //   • RENTAL EQUIPMENT INFORMATION is a Sale-side shared task whose answers
  //     (hot water tank rented/owned, its provider, other rental equipment) are
  //     the whole point of it — there is no upload behind it.
  //
  // The UPLOADS behind those two tasks are read from both document stores, the
  // way identification and the APS are. Reading task_responses alone (and only
  // rows with a non-null file_url) is what shipped this entry without the
  // client's lock box photos while the deal page kept showing them.
  //
  // Property facts, not personal ones, so they merge across the family into one
  // PDF the way identification does rather than repeating per party.
  const lockboxTasks = taskRows.filter((t) => isLockboxTitle(t.title));
  const rentalTasks = taskRows.filter((t) => isRentalTitle(t.title));
  try {
    const propertyPdf = await PackageDoc.create(meta);
    let rows = 0;
    // Same "no duplicate answers" rule the family view needs: a shared task is
    // copied onto every party's deal, so the same code arrives two or three
    // times over.
    const seenRow = new Set<string>();
    // A section heading is drawn by the first row that actually lands under it —
    // pass it on every call and it appears once, or not at all when the file has
    // nothing to say there.
    const printedHeadings = new Set<string>();
    const addRow = (label: string, value: string, heading?: string) => {
      const clean = String(value ?? "").trim();
      if (!clean) return;
      const key = `${label.toLowerCase()}::${clean.toLowerCase()}`;
      if (seenRow.has(key)) return;
      seenRow.add(key);
      if (rows === 0) {
        propertyPdf.newPage();
        propertyPdf.band("Property Information", fileNumber || undefined);
      }
      rows++;
      const head = heading && !printedHeadings.has(heading) ? heading : undefined;
      if (head) printedHeadings.add(head);
      propertyPdf.kvRow(label, clean, head);
    };

    // Deal columns first — the lock box code as staff actually enter it today.
    // Ordered by party so a family reads primary-first like every other entry.
    const dealsByRank = [...(dealRows ?? [])].sort(
      (a, b) =>
        (personRank.get((a.lead_id as string) ?? "") ?? MAX_INT) -
        (personRank.get((b.lead_id as string) ?? "") ?? MAX_INT),
    );
    for (const d of dealsByRank) {
      addRow("Lock Box Code", (d.lockbox_code as string) ?? "", "Property access");
      addRow("Garage Access Code", (d.garage_access_code as string) ?? "", "Property access");
    }

    // Then the same code where a file carries it as a task answer instead.
    for (const task of lockboxTasks) {
      for (const r of (responsesByTask.get(task.id) ?? []).sort(
        (a, b) => fieldOrder(a) - fieldOrder(b),
      )) {
        if (r.field_type === "file") continue;
        addRow(
          humanise(r.field_label || r.field_id, "Lock Box Code"),
          String(r.value ?? ""),
          "Property access",
        );
      }
    }

    // Rental equipment — its own heading, since it answers a different question.
    for (const task of rentalTasks) {
      for (const r of (responsesByTask.get(task.id) ?? []).sort(
        (a, b) => fieldOrder(a) - fieldOrder(b),
      )) {
        if (r.field_type === "file") continue;
        addRow(
          String(r.field_label || r.field_id || "Rental equipment"),
          String(r.value ?? ""),
          "Rental equipment",
        );
      }
    }

    // A scan attached to either task (a rental contract, a photo of the box)
    // rides behind the answers, so nothing is lost by taking these tasks out of
    // the per-task loop.
    //
    // BOTH stores, for the same reason loadIdentificationDocs consults both: a
    // client's upload reaches us as a task_response AND as a lead_corporate_docs
    // row, and the two go out of step — a re-submitted task deletes and
    // re-inserts its responses while the document rows survive, and "Save draft"
    // / "Replace" write only the document row. Reading task_responses alone was
    // what emptied this entry of the client's lock box uploads while the deal
    // page went on showing them.
    const propertyFiles: Array<{ fileUrl: string; fileName: string; label: string }> = [];
    const seenPropertyFile = new Set<string>();
    const pushPropertyFile = (fileUrl: string, fileName: string, label: string) => {
      // Shared tasks are copied onto every party's deal, so the same photo
      // arrives two or three times over on a family file.
      if (!fileUrl || seenPropertyFile.has(fileUrl)) return;
      seenPropertyFile.add(fileUrl);
      propertyFiles.push({ fileUrl, fileName: fileName || "Document", label: label || "Document" });
    };

    for (const t of [...lockboxTasks, ...rentalTasks]) {
      for (const r of responsesByTask.get(t.id) ?? []) {
        if (r.field_type !== "file" || !r.file_url) continue;
        pushPropertyFile(
          r.file_url,
          r.file_name || r.field_label || "Document",
          r.field_label || r.file_name || t.title || "Document",
        );
      }
    }
    // Documents filed against the FILE rather than a task, whose type names the
    // lock box or the rental equipment. lead_corporate_docs carries no task_id,
    // so its own label is the only attribution there is.
    for (const d of corporate ?? []) {
      const url = d.file_url as string | null;
      if (!url) continue;
      const label = `${d.custom_type ?? ""} ${d.document_type ?? ""} ${d.doc_type ?? ""}`;
      if (!isLockboxTitle(label) && !isRentalTitle(label)) continue;
      pushPropertyFile(
        url,
        (d.file_name as string) || "Document",
        humanise((d.custom_type as string) || (d.document_type as string), "Document"),
      );
    }

    let index = 0;
    for (const doc of toMerge(propertyFiles)) {
      index++;
      const bytes = await fetchBytes(doc.fileUrl, doc.fileName);
      if (!bytes) continue;
      await propertyPdf.addDocument({
        bytes,
        fileUrl: doc.fileUrl,
        fileName: doc.fileName,
        heading: "Property Information",
        sublabel: doc.label,
        index,
        total: propertyFiles.length,
        sectionTitle: "Property Information",
      });
    }

    propertyInfoRows = rows;
    // `skipped` matters as much as the two counters: a document that could not
    // be embedded has a note page in this PDF and travels as its own original,
    // and dropping the entry here would strand that note AND lose the skip
    // report the clerk email needs to attach the original.
    if (rows > 0 || propertyPdf.documents > 0 || propertyPdf.skipped.length > 0) {
      await finish("Property Information", propertyPdf, "property");
    }
    // The symptom that started this — "the client's lock box uploads are not in
    // the property PDF" — was invisible in the logs. Say it out loud.
    logger.info(
      `[dealPackage] property information: ${rows} fact(s), ${propertyPdf.documents}/${propertyFiles.length} document(s) merged` +
        (mergeDocuments ? "" : " (merging off — every document is attached separately)"),
    );
    if (mergeDocuments) {
      for (const doc of propertyFiles) {
        if (!consumedUrls.has(doc.fileUrl)) {
          logger.warn(
            `[dealPackage] property information could not merge "${doc.fileName}" — it ships as its own attachment instead`,
          );
        }
      }
    }
  } catch (err) {
    logger.error("[dealPackage] property information entry failed:", err);
  }

  // ── 5. One entry per task ──────────────────────────────────────────────────
  // Deal-page order: milestone order, then task order within it, with each
  // person's copy of a task kept beside the primary's.
  //
  // The tasks whose content has already been merged family-wide above are left
  // out here — identification, personal information, the APS, and the lock box
  // and rental tasks that section 4 absorbed — so nothing ships twice.
  const packagedTasks = taskRows.filter(
    (t) =>
      !isIdentificationTitle(t.title) &&
      !isPersonalInfoTitle(t.title) &&
      !isApsTitle(t.title) &&
      !isLockboxTitle(t.title) &&
      !isRentalTitle(t.title),
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
      // one PDF for the whole task however many files it holds. With merging off
      // the entry is the answers alone and each upload is attached separately.
      let index = 0;
      for (const r of toMerge(fileRows)) {
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
      await finish(named, pdf, "task");
    } catch (err) {
      logger.error(`[dealPackage] task entry "${title}" failed:`, err);
      failed.push(title);
    }
  }

  // ── 6. Leftover documents ──────────────────────────────────────────────────
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
    // An ID or an agreement that couldn't be embedded already has its say inside
    // the combined entry above; a second copy here would only duplicate it.
    if (String(d.doc_type ?? "").toLowerCase() === "identification") continue;
    if (isApsDocType(d.doc_type as string | null, d.custom_type as string | null)) continue;
    leftovers.push({
      fileUrl: url,
      fileName: (d.file_name as string) || "Document",
      owner: leadNameById.get(d.lead_id as string) ?? "",
      label: humanise(
        (d.custom_type as string) || (d.document_type as string) || (d.doc_type as string),
        "Document",
      ),
    });
  }

  for (const r of responseRows) {
    if (r.field_type !== "file" || !r.file_url || consumedUrls.has(r.file_url)) continue;
    const task = taskById.get(r.task_id);
    // Whatever couldn't be embedded into one of the merged entries stays there —
    // it travels as its own original file instead (see `skipped`/`originals`).
    if (task && (isIdentificationTitle(task.title) || isApsTitle(task.title))) continue;
    leftovers.push({
      fileUrl: r.file_url,
      fileName: r.file_name || r.field_label || "Document",
      owner: task ? leadNameById.get(leadByDeal.get(task.deal_id) ?? "") ?? "" : "",
      label: humanise(task?.title || r.field_label, "Document"),
    });
  }

  // A document hung off the TASK rather than one of its form fields. Same
  // grouping as any other upload: to a clerk it is this task's document.
  for (const t of taskRows) {
    const url = t.document_url;
    if (!url || consumedUrls.has(url)) continue;
    leftovers.push({
      fileUrl: url,
      fileName: t.document_name || "Document",
      owner: leadNameById.get(leadByDeal.get(t.deal_id) ?? "") ?? "",
      label: humanise(t.title, "Document"),
    });
  }

  // `deal_documents` — deal-keyed document rows. Nothing in this repo writes the
  // table, so its shape is the one thing here we don't control: queried on its
  // own, and a failure costs only these rows rather than the whole package.
  if (dealIds.length) {
    const { data: dealDocs, error: dealDocsError } = await supabaseAdmin
      .from("deal_documents")
      .select("deal_id, file_url, name, type")
      .in("deal_id", dealIds);
    if (dealDocsError) {
      logger.warn(
        `[dealPackage] deal_documents sweep failed — those rows are missing from this package:`,
        dealDocsError,
      );
    }
    for (const d of dealDocs ?? []) {
      const url = d.file_url as string | null;
      if (!url || consumedUrls.has(url)) continue;
      leftovers.push({
        fileUrl: url,
        fileName: (d.name as string) || "Document",
        owner: leadNameById.get(leadByDeal.get(d.deal_id as string) ?? "") ?? "",
        label: humanise((d.type as string) || (d.name as string), "Document"),
      });
    }
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

  // Nothing to group when documents aren't being merged: every one of these
  // blobs is unconsumed, so the caller attaches it in its original form.
  for (const { title, docs } of mergeDocuments ? [...groups.values()] : []) {
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
      await finish(title, pdf, "leftover");
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
    apsDocs,
    personalInfoPeople,
    propertyInfoRows,
    mergedDocuments: mergeDocuments,
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
 * "Agreement of Purchase and Sale and Amendments" — the seeded title — plus the
 * "APS" shorthand a manually-added task tends to carry. Deliberately loose for
 * the same reason isIdentificationTitle is: task titles are per-deal SNAPSHOTS
 * of a template's name, so a file created before a rename keeps the old wording.
 */
function isApsTitle(title: string | null | undefined): boolean {
  const t = String(title ?? "").toLowerCase();
  return t.includes("agreement of purchase and sale") || /\baps\b/.test(t);
}

/** "Enter Lockbox Code", "Lock Box Code". */
function isLockboxTitle(title: string | null | undefined): boolean {
  return /lock\s*box/i.test(String(title ?? ""));
}

/** "Rental Equipment Information". */
function isRentalTitle(title: string | null | undefined): boolean {
  return /rental/i.test(String(title ?? ""));
}

/**
 * Is this lead_corporate_docs row an agreement?
 *
 * Four shapes are in the data, all of them live (see completeApsTask.ts):
 * doc_type "aps_purchase" / "aps_sale" / "aps", and the legacy rows written as
 * doc_type "document" with the side carried in custom_type ("APS Purchase
 * Document").
 */
function isApsDocType(docType: string | null | undefined, customType: string | null | undefined): boolean {
  const dt = String(docType ?? "").toLowerCase().trim();
  if (dt === "aps" || dt === "aps_purchase" || dt === "aps_sale") return true;
  return /\baps\b/i.test(String(customType ?? ""));
}

/** "Purchase" / "Sale" / "" — which side of a P&S file an agreement is for. */
function apsSideLabel(docType: string | null | undefined, customType: string | null | undefined): string {
  const hay = `${docType ?? ""} ${customType ?? ""}`.toLowerCase();
  if (hay.includes("purchase")) return "Purchase";
  if (hay.includes("sale")) return "Sale";
  return "";
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

/** One agreement on the file. */
export interface ApsDoc {
  /** Whose upload it was — "" when the row belongs to a deal with no lead. */
  leadId: string;
  fileUrl: string;
  fileName: string;
  /** "Purchase" / "Sale" / the field's own label — captioned onto the page. */
  label: string;
}

/** An answer typed on the APS task itself, if a deck has any such field. */
interface ApsAnswer {
  leadId: string;
  label: string;
  value: string;
}

export interface ApsMaterial {
  docs: ApsDoc[];
  answers: ApsAnswer[];
}

/**
 * Every agreement on the file, deduped by blob URL and ordered purchase-side
 * first.
 *
 * Both stores are read, because the APS legitimately lands in either. An
 * agreement uploaded at intake is a lead_corporate_docs row (doc_type
 * "aps_purchase" / "aps_sale" / "aps", or a legacy "document" row whose
 * custom_type names the APS); completeApsTask.ts bridges those onto the APS task
 * as task_responses, but only for files it has run over, and a client answering
 * the task writes only task_responses. Reading one store alone loses agreements.
 */
export async function loadApsMaterial(leadIds: string[], dealIds: string[]): Promise<ApsMaterial> {
  const docs: ApsDoc[] = [];
  const answers: ApsAnswer[] = [];
  if (leadIds.length === 0 && dealIds.length === 0) return { docs, answers };

  const [{ data: corporate }, { data: deals }, { data: tasks }] = await Promise.all([
    leadIds.length
      ? supabaseAdmin
          .from("lead_corporate_docs")
          .select("lead_id, file_url, file_name, doc_type, custom_type, created_at")
          .in("lead_id", leadIds)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] }),
    dealIds.length
      ? supabaseAdmin.from("deals").select("id, lead_id").in("id", dealIds)
      : Promise.resolve({ data: [] }),
    dealIds.length
      ? supabaseAdmin
          .from("tasks")
          .select("id, title, deal_id, task_template_id")
          .in("deal_id", dealIds)
          .eq("is_deleted", false)
      : Promise.resolve({ data: [] }),
  ]);

  const apsTasks = (tasks ?? []).filter((t) => isApsTitle(t.title as string));

  // Which side a task's agreement is for. NOT derivable from the task title or
  // the response's field label — both read "Agreement of Purchase and Sale" on
  // either side of a P&S file — so it comes from the template's lead_type, which
  // is the same thing completeApsTask.ts routes bridged uploads by.
  const apsTemplateIds = Array.from(
    new Set(apsTasks.map((t) => t.task_template_id as string | null).filter(Boolean)),
  ) as string[];
  const { data: apsTemplates } = apsTemplateIds.length
    ? await supabaseAdmin.from("task_templates").select("id, lead_type").in("id", apsTemplateIds)
    : { data: [] };
  const sideByTemplate = new Map<string, string>(
    (apsTemplates ?? []).map((t) => [t.id as string, apsSideLabel(t.lead_type as string, null)]),
  );
  const sideByTask = new Map<string, string>(
    apsTasks.map((t) => [
      t.id as string,
      sideByTemplate.get((t.task_template_id as string) ?? "") ?? "",
    ]),
  );
  const leadByDeal = new Map<string, string>(
    (deals ?? []).map((d) => [d.id as string, (d.lead_id as string) ?? ""]),
  );
  const dealByTask = new Map<string, string>(
    apsTasks.map((t) => [t.id as string, (t.deal_id as string) ?? ""]),
  );
  const { data: responses } = apsTasks.length
    ? await supabaseAdmin
        .from("task_responses")
        .select("task_id, field_label, field_type, value, file_url, file_name")
        .in(
          "task_id",
          apsTasks.map((t) => t.id as string),
        )
    : { data: [] };

  const seen = new Set<string>();
  const pushDoc = (doc: ApsDoc) => {
    if (!doc.fileUrl || seen.has(doc.fileUrl)) return;
    seen.add(doc.fileUrl);
    docs.push(doc);
  };

  for (const d of corporate ?? []) {
    if (!isApsDocType(d.doc_type as string | null, d.custom_type as string | null)) continue;
    pushDoc({
      leadId: (d.lead_id as string) ?? "",
      fileUrl: d.file_url as string,
      fileName: (d.file_name as string) || "Agreement of Purchase and Sale",
      label: apsSideLabel(d.doc_type as string | null, d.custom_type as string | null),
    });
  }

  for (const r of responses ?? []) {
    const leadId = leadByDeal.get(dealByTask.get(r.task_id as string) ?? "") ?? "";
    if (r.field_type === "file") {
      if (!r.file_url) continue;
      pushDoc({
        leadId,
        fileUrl: r.file_url as string,
        fileName: (r.file_name as string) || "Agreement of Purchase and Sale",
        label: sideByTask.get(r.task_id as string) || "Agreement",
      });
      continue;
    }
    const value = String(r.value ?? "").trim();
    if (!value) continue;
    answers.push({
      leadId,
      label: String(r.field_label ?? "Detail"),
      value,
    });
  }

  // Purchase side first on a P&S file, which is the order the clerks read them
  // in; everything unlabelled keeps its arrival order at the end.
  const sideRank = (label: string) => (label === "Purchase" ? 0 : label === "Sale" ? 1 : 2);
  docs.sort((a, b) => sideRank(a.label) - sideRank(b.label));

  return { docs, answers };
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
