// "Email to clerk" — sends a file's whole client document package to the firm's
// conveyancing clerks.
//
// Sits next to "Download All" on the deal page and enumerates a file exactly
// the way that button does — both come from src/lib/dealPackage.ts, so the email
// and the ZIP can no longer disagree about what is ON a file. What they no
// longer share is the PACKAGING:
//
//   • EVERY UPLOADED DOCUMENT IS ATTACHED ON ITS OWN, in the bytes it was
//     uploaded with, under the firm's filing name. Nothing is merged.
//     Identification, the agreement(s) of purchase and sale and a task's uploads
//     briefly travelled as combined PDFs; that cost each document its own
//     filename and its byte-for-byte formatting (the APS included), so the
//     clerks asked for the originals back. "Download All" still merges — this
//     email does not.
//   • The package's GENERATED pages still ride along, because nothing else
//     carries them: PERSONAL INFORMATION (every party's answers), PROPERTY
//     INFORMATION (the lock box code — a column on the deal, so no document ever
//     held it — and the rental equipment answers) and one PDF per TASK holding
//     that task's typed answers. Those are rendered answers, not documents:
//     there is no original to attach in their place.
//
// Mechanically that is buildDealPackage(dealId, { mergeDocuments: false }) — the
// same sweep of all three document stores, with nothing embedded and therefore
// nothing reported in `consumedUrls`, which leaves collectFamilyDocuments() to
// attach every blob on the file individually.
//
// Routing: the clerk inbox is chosen by the file's type —
//   Purchase        → CLERK_PURCHASE_EMAIL
//   Sale            → CLERK_SALE_EMAIL
//   Purchase & Sale → BOTH, on one email (not two), so the attachments are
//                     transferred once and the two clerks can see each other on
//                     the thread.
//
// CLERK_ALWAYS_EMAIL rides along on top of whichever of those resolved — the
// firm wants one supervising address on EVERY file regardless of side, and
// "every file" is meant literally: it is added even when no side resolves, so a
// Refinance (or a blank type) still reaches that address instead of refusing the
// send outright. Only turning it off (CLERK_ALWAYS_EMAIL="off") can leave such a
// file with no inbox, and then the caller still refuses rather than guessing.
//
// The deposit-proof email does NOT share that last part — see
// clerkRecipientsForType() vs clerkDocumentRecipients() below.
//
// CLERK_DOCUMENTS_EMAIL overrides all of that when it is set: it IS the
// recipient list, verbatim, for every file regardless of type. It exists
// because the firm routes this email to one shared inbox in production while
// dev mails a single tester, and because CLERK_PURCHASE_EMAIL /
// CLERK_SALE_EMAIL are SHARED with the deposit-proof email (see
// sendDepositProofEmail.ts) - widening those to retarget this email would
// silently change who is told a client's closing funds arrived, which nobody
// asked for. Same override shape, and same reason, as DEPOSIT_PROOF_EMAIL.
//
// Documents are NOT side-scoped on a P&S file. Both clerks get everything: a
// purchase clerk routinely needs the sale-side ID and vice versa, and guessing
// wrong would silently withhold a document someone is waiting on. Splitting by
// side is a deliberate non-goal here.
//
// Attachment naming: every document goes out as
// "<file number> - <task name> - <client name>.<ext>" so a clerk can file and
// search them, EXCEPT anything uploaded against the APS task (and any
// lead_corporate_docs row with an "aps" doc_type), which keeps the name it was
// uploaded under. See collectFamilyDocuments().
//
// Wording: the subject and body come from the "Client Documents to Clerk"
// email_templates row when one exists, so staff can retune them without a
// deploy. renderBody()/defaultSubject() below are the fallback used when the row
// is missing, inactive or empty — never a silent failure to send.

import { sendEmail } from "./email/emailTransport";
import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import {
  ATTACHMENT_BUDGET_BYTES,
  collectFamilyDocuments,
  renderLinkedDocsHtml,
  withEmailDocumentLinks,
  type EmailAttachment,
} from "./familyDocuments";
import { buildDealPackage, sanitizeEntryName } from "./dealPackage";
import { formatLeadTypeLabel, buildLeadAddressPartsForEmail, renderTransactionPhrase } from "./leadEmailAddress";
import { decodeTemplateBraces, renderTemplateSafe, type TemplateValue } from "./renderEmailTemplate";
import { logger } from "./logger";
import { clerkDocumentRecipients, clerkDocumentsOverride } from "./clerkRecipients";

// Recipient rules live in ./clerkRecipients — a dependency-free module, so the
// addresses can be unit-tested (tests/clerkRecipients.test.ts) without loading
// Supabase, the email transport and the PDF builder. Import them from there, not
// through this file: one path to the addresses is what keeps this email and the
// deposit-proof email from drifting apart.

/**
 * email_templates row that owns this email's wording. Matched with ILIKE
 * `%name%`, the same way the other senders match theirs, so a row named
 * "Client Documents to Clerk (Purchase & Sale)" still resolves.
 */
export const CLERK_TEMPLATE_NAME = "Client Documents to Clerk";

export type ClerkEmailResult = {
  success: boolean;
  /** Addresses the mail actually went to. */
  recipients: string[];
  /** Attachments on the email — every document, plus the generated answer PDFs. */
  attached: number;
  /** Documents too large to attach, sent as links instead. */
  linked: number;
  /**
   * ID documents merged into a combined identification PDF — always 0 while this
   * email sends documents separately. Kept so the caller's wording still holds
   * if merging is ever turned back on.
   */
  identification: number;
  /** Agreements merged into a combined APS PDF — 0, for the same reason. */
  aps: number;
  /** Parties whose answers are in the combined personal-information PDF. */
  personalInfo: number;
  /** Facts (lock box code, rental answers) in the property-information PDF. */
  propertyInfo: number;
  error?: string;
};

/** Absolute link back into the admin portal for the email CTA. */
function adminBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The values every placeholder — and the built-in body — is built from. */
interface ClerkEmailFacts {
  /** Every party on the file, full names: "Pavithra Kumar and Ravi Kumar". */
  clientNames: string;
  /** One name per line, for the body's "Clients:" block. */
  clientNameList: string[];
  /** The primary lead only. */
  clientName: string;
  /** "Sale of 2615 Ellesmere Road, Toronto, Ontario, M5E 0G1". */
  transaction: string;
  /** Street line only — "2615 Ellesmere Road". */
  propertyStreet: string;
  /** Full address(es), city and postal code included. */
  propertyAddress: string;
  fileNumber: string;
  leadTypeLabel: string;
  closingDate: string;
  attached: number;
  linked: number;
  dealUrl: string;
}

/**
 * "Client documents — 2615 Ellesmere Road (#26S-0356, August 31, 2026)"
 *
 * Street line first: an inbox list truncates the subject, so the part that
 * identifies the property has to come before the file number and closing date.
 * Every segment degrades gracefully when its data is missing.
 */
function defaultSubject(f: ClerkEmailFacts): string {
  const bracket = [f.fileNumber ? `#${f.fileNumber}` : "", f.closingDate]
    .filter(Boolean)
    .join(", ");
  return (
    "Client documents" +
    (f.propertyStreet ? ` — ${f.propertyStreet}` : "") +
    (bracket ? ` (${bracket})` : "")
  );
}

/**
 * The built-in clerk email body, used when the "Client Documents to Clerk"
 * template row is absent, inactive or empty.
 *
 * Template rows live in the shared database and are read by every environment at
 * once, while the code resolving their placeholders ships per-deploy — so a
 * template that references a new placeholder emails raw "{{ }}" syntax wherever
 * the code hasn't landed (this bit us on 2026-08-10). Keeping a complete body
 * here means the send is never blocked on the row existing, and a placeholder
 * this deploy doesn't know is simply left alone by renderTemplateSafe.
 */
function renderBody(f: ClerkEmailFacts): string {
  const clients = f.clientNameList.length ? f.clientNameList : [f.clientNames];
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
    `<p>Hi,</p>` +
    `<p>Please find attached the client documents for <strong>${escapeHtml(f.clientNames)}</strong>` +
    `${f.transaction ? ` — ${escapeHtml(f.transaction)}` : ""}.</p>` +
    `<p style="margin:0 0 4px;"><strong>Client${clients.length === 1 ? "" : "s"}:</strong></p>` +
    `<ul style="margin:0 0 16px;padding-left:20px;">` +
    clients.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
    `</ul>` +
    // What's in the package is spelled out by renderPackageSummaryHtml, which is
    // appended after this body — it's generated HTML whose shape follows the
    // code, not wording staff should have to maintain.
    `<p style="margin-top:24px;">` +
    `<a href="${f.dealUrl}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">` +
    `Open file ${escapeHtml(f.fileNumber)}</a></p>` +
    `<p style="color:#64748b;font-size:13px;margin-top:24px;">` +
    `File ${escapeHtml(f.fileNumber)} &middot; ${escapeHtml(f.leadTypeLabel)} &middot; Closing ${escapeHtml(f.closingDate)}` +
    `</p></div>`
  );
}

/**
 * "What's attached" — the generated answer PDFs first, then the documents, every
 * one of which travels as its own file.
 *
 * Generated in CODE and appended after the body, for the same reason the
 * "too large to attach" list is: it's a shape that changes with the code, and a
 * template row referencing a placeholder this deploy doesn't know would email
 * raw "{{ }}" syntax (see the note on renderBody). Returns "" when there is
 * nothing to describe.
 */
function renderPackageSummaryHtml(pkg: {
  identification: number;
  aps: number;
  personalInfo: number;
  propertyInfo: number;
  taskPdfs: number;
  separate: number;
}): string {
  const items: string[] = [];
  if (pkg.identification > 0) {
    items.push(
      `<strong>Identification</strong> — ${pkg.identification} ID document` +
        `${pkg.identification === 1 ? "" : "s"} combined into one PDF`,
    );
  }
  if (pkg.aps > 0) {
    items.push(
      `<strong>Agreement of Purchase and Sale</strong> — ${pkg.aps === 1 ? "the agreement" : `all ${pkg.aps} agreements and amendments`} ` +
        `combined into one PDF`,
    );
  }
  if (pkg.personalInfo > 0) {
    items.push(
      `<strong>Personal Information</strong> — ${pkg.personalInfo === 1 ? "the client's" : `all ${pkg.personalInfo} clients'`} ` +
        `details in one PDF`,
    );
  }
  if (pkg.propertyInfo > 0) {
    items.push(
      `<strong>Property Information</strong> — the lock box code and rental ` +
        `equipment details for the property`,
    );
  }
  if (pkg.taskPdfs > 0) {
    items.push(
      `${pkg.taskPdfs} task PDF${pkg.taskPdfs === 1 ? "" : "s"} — the answers the client ` +
        `gave on ${pkg.taskPdfs === 1 ? "that task" : "those tasks"}`,
    );
  }
  if (pkg.separate > 0) {
    items.push(
      `${pkg.separate} document${pkg.separate === 1 ? "" : "s"}, each attached ` +
        `individually in the format it was uploaded in`,
    );
  }
  if (items.length === 0) return "";

  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
    `<p style="margin:0 0 4px;"><strong>Attached:</strong></p>` +
    `<ul style="margin:0 0 16px;padding-left:20px;">` +
    items.map((i) => `<li>${i}</li>`).join("") +
    `</ul></div>`
  );
}

/**
 * `deals.closing_date` is a DATE — format its Y/M/D parts in UTC so it doesn't
 * render as the previous day in a negative-offset timezone.
 */
function formatClosingDate(raw: string | null | undefined): string {
  if (!raw) return "TBD";
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(raw);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fullName(row: { first_name?: string | null; last_name?: string | null }): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

function joinNames(names: string[]): string {
  const clean = names.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** The admin-authored wording, or null to use the built-in body. */
async function loadClerkTemplate(): Promise<{ subject: string | null; body: string } | null> {
  try {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("name, subject, body, is_active")
      .ilike("name", `%${CLERK_TEMPLATE_NAME}%`)
      .eq("deleted", false);

    const row = (data ?? []).find(
      (t) => t.is_active && typeof t.body === "string" && t.body.trim() !== "",
    );
    if (!row) return null;
    return { subject: row.subject ?? null, body: row.body as string };
  } catch (err) {
    // A missing table/column must never block the send — fall back to the body
    // in this file.
    logger.warn("[ClerkDocuments] template lookup failed — using the built-in body:", err);
    return null;
  }
}

/** Send one deal family's document package to the appropriate clerk inbox(es). */
export async function sendClerkDocumentsEmail(dealId: string): Promise<ClerkEmailResult> {
  const empty: ClerkEmailResult = {
    success: false,
    recipients: [],
    attached: 0,
    linked: 0,
    identification: 0,
    aps: 0,
    personalInfo: 0,
    propertyInfo: 0,
  };

  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, file_number, type, closing_date, property_address, selling_property_address")
    .eq("id", dealId)
    .maybeSingle();

  if (!deal) return { ...empty, error: "Deal not found" };

  // The lead's type is authoritative (the deal's can be blank on older rows).
  const { data: primaryLead } = deal.lead_id
    ? await supabaseAdmin.from("leads").select("*").eq("id", deal.lead_id).maybeSingle()
    : { data: null };

  const rawType = primaryLead?.lead_type ?? deal.type;
  // An override also bypasses the "which side is this file" gate below, which
  // is the point: a type we cannot route (Refinance, blank) has an inbox once
  // one is named outright.
  const recipients = clerkDocumentsOverride() ?? clerkDocumentRecipients(rawType);
  // Only reachable now with CLERK_ALWAYS_EMAIL="off" AND an unroutable type, or
  // with every clerk variable blanked — i.e. a deliberate configuration, not an
  // ordinary Refinance file.
  if (recipients.length === 0) {
    return {
      ...empty,
      error: `No clerk inbox is configured for file type "${formatLeadTypeLabel(rawType) || "unknown"}"`,
    };
  }

  // Whole family, so a co-purchaser's ID travels with the primary's package.
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

  const familyLeadIds = (familyLeads ?? []).map((l) => l.id);

  const fileNumber = deal.file_number ?? "";

  const clientName = primaryLead ? fullName(primaryLead) : "";
  const coParties = (familyLeads ?? []).filter((l) => l.id !== primaryLead?.id);
  const coPartyNames = coParties.map(fullName).filter(Boolean);
  const clientNameList = [clientName, ...coPartyNames].filter(Boolean);
  const clientNames = joinNames(clientNameList) || clientName || "Client";

  // THE package — the same enumeration "Download All" ships as a ZIP, built
  // WITHOUT merging: the entries come back holding only the generated answers
  // (personal information, the property facts, each task's typed responses) and
  // every uploaded document is left untouched for collectFamilyDocuments() to
  // attach on its own. Building both exports from src/lib/dealPackage.ts is what
  // stops the email and the ZIP disagreeing about what is on a file.
  const pkg = await buildDealPackage(dealId, { mergeDocuments: false });
  if (!pkg) return { ...empty, error: "Deal not found" };

  // Spend the attachment budget on the generated entries first — they are small
  // and no other copy of them exists — then leave the rest to the documents
  // below, which can be linked when they're too large as a generated PDF cannot.
  const stem = fileNumber ? `${fileNumber} - ` : "";
  const packageAttachments: EmailAttachment[] = [];
  const consumedByEmail = new Set<string>();
  let packageBytes = 0;
  // The per-task answer PDFs, which the body's "Attached:" breakdown counts on
  // their own. Counted by entry.kind, not by title: the two title comparisons
  // this used to make went stale the moment the APS and property entries were
  // added.
  let taskPdfCount = 0;
  for (const entry of pkg.entries) {
    if (packageBytes + entry.bytes.byteLength > ATTACHMENT_BUDGET_BYTES) {
      logger.warn(
        `[ClerkDocuments] entry "${entry.title}" (${entry.bytes.byteLength} bytes) exceeds the ` +
          `attachment budget — its source documents are attached or linked separately instead`,
      );
      continue;
    }
    packageBytes += entry.bytes.byteLength;
    packageAttachments.push({
      filename: `${stem}${sanitizeEntryName(entry.title)}.pdf`,
      content: Buffer.from(entry.bytes),
    });
    if (entry.kind === "task" || entry.kind === "leftover") taskPdfCount++;
    for (const url of entry.consumedUrls) consumedByEmail.add(url);
  }

  // EVERY document on the file, each as its own attachment in the bytes it was
  // uploaded with, renamed into the firm's filing convention. With merging off
  // the package consumes no blobs, so `excludeUrls` is empty and this sweep is
  // what actually carries the documents — anything past the budget becomes a
  // link rather than being dropped.
  const collected = await collectFamilyDocuments(dealIds, familyLeadIds, adminBaseUrl(), {
    fileNumber,
    excludeUrls: consumedByEmail,
    budgetBytes: Math.max(0, ATTACHMENT_BUDGET_BYTES - packageBytes),
  });
  // Whatever spilled past the budget goes out as a tokenised link the clerk can
  // open from their inbox. Without this the overflow list points at
  // /api/admin/documents/download, which middleware.ts gates on an admin
  // session: the clerk clicked the one document that had NOT arrived and got
  // {"success":false,"error":"Unauthorized"}. Falls back to the old href if the
  // token cannot be minted, so the email always sends.
  const docs = await withEmailDocumentLinks(collected, {
    email: recipients[0],
    dealId,
  });

  const attachments = [...packageAttachments, ...docs.attachments];
  if (attachments.length === 0 && docs.linked.length === 0) {
    return { ...empty, error: "There are no uploaded documents on this file yet" };
  }

  const leadTypeLabel = formatLeadTypeLabel(rawType);
  const addressParts = await buildLeadAddressPartsForEmail(primaryLead);
  const transaction = renderTransactionPhrase(addressParts, leadTypeLabel);
  const propertyAddress =
    [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ") ||
    deal.property_address ||
    deal.selling_property_address ||
    "";
  // Street line only — "2615 Ellesmere Road", not the full
  // "2615 Ellesmere Road, Toronto, Ontario, M5E 0G1". Derived from the SAME
  // joined strings as propertyAddress so it inherits buildLeadAddressPartsForEmail's
  // family-side fallbacks (a co-lead holding the sale side, etc); joinAddress
  // there glues street, city, province and postal with ", ", so segment one is
  // the street.
  const streetOf = (joined: string) => (joined.split(",")[0] ?? "").trim();
  const propertyStreet =
    [streetOf(addressParts.purchase), streetOf(addressParts.selling)]
      .filter(Boolean)
      .join(" and ") ||
    streetOf(deal.property_address ?? "") ||
    streetOf(deal.selling_property_address ?? "") ||
    "";
  const closingDate = formatClosingDate(deal.closing_date);
  const dealUrl = `${adminBaseUrl()}/admin/deals/${deal.id}`;

  const facts: ClerkEmailFacts = {
    clientNames,
    clientNameList,
    clientName,
    transaction,
    propertyStreet,
    propertyAddress,
    fileNumber,
    leadTypeLabel,
    closingDate,
    attached: attachments.length,
    linked: docs.linked.length,
    dealUrl,
  };

  const template = await loadClerkTemplate();

  const values: Record<string, string> = {
    // Names — client_names is the one the brief asked for (all parties).
    client_names: clientNames,
    client_name: clientName,
    co_party_names: coPartyNames.join(", "),
    party_summary: clientNames,
    // Property / file.
    transaction,
    property_street: propertyStreet,
    property_address: propertyAddress,
    file_number: fileNumber,
    lead_type: leadTypeLabel,
    closing_date: closingDate,
    // Package.
    attached_count: String(attachments.length),
    linked_count: String(docs.linked.length),
    document_count: String(attachments.length + docs.linked.length),
    identification_count: String(pkg.identificationDocs),
    aps_count: String(pkg.apsDocs),
    personal_info_count: String(pkg.personalInfoPeople),
    property_info_count: String(pkg.propertyInfoRows),
    separate_count: String(docs.attachments.length),
    deal_url: dealUrl,
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "").trim();
    if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
    // deal_url is system-generated, so it may pass through unescaped inside an
    // href. Everything else is client-supplied and gets HTML-escaped.
    return { value: values[key], raw: key === "deal_url" };
  };

  // The "too large to attach" list is APPENDED rather than templated, for the
  // same reason as the other senders: it's generated HTML whose shape changes
  // with the code, not wording staff should have to maintain.
  const html =
    (template
      ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
      : renderBody(facts)) +
    renderPackageSummaryHtml({
      identification: pkg.identificationDocs,
      aps: pkg.apsDocs,
      personalInfo: pkg.personalInfoPeople,
      propertyInfo: pkg.propertyInfoRows,
      taskPdfs: taskPdfCount,
      separate: docs.attachments.length,
    }) +
    renderLinkedDocsHtml(docs.linked);

  const subject = template?.subject?.trim()
    ? renderTemplateSafe(template.subject, resolve, { escape: false })
    : defaultSubject(facts);

  // Internal mail: firm-agnostic on purpose (see CLAUDE.md), so `firm: null`
  // keeps the legacy sender AND pins this to Resend whatever the SMTP rollout
  // does. That matters here more than anywhere else — this email carries up to
  // 25 MB of attachments (~33 MB on the wire), which is exactly the payload most
  // likely to be refused by an SMTP server's SIZE limit.
  //
  // `replyTo: null` preserves the existing behaviour of setting none at all.
  const result = await sendEmail(
    {
      to: recipients,
      subject,
      html,
      ...(attachments.length > 0 ? { attachments } : {}),
    },
    { firm: null, label: "clerk-documents", replyTo: null },
  );

  if (!result.ok) {
    logger.error(`[ClerkDocuments] send failed — deal=${dealId}: ${result.error}`);
    return { ...empty, error: `Could not send the email: ${result.error}` };
  }

  logger.info(
    `[ClerkDocuments] sent deal=${dealId} file=${fileNumber} to=${recipients.join(", ")} ` +
      `template=${template ? "db" : "built-in"} ` +
      `attached=${attachments.length} (merge=${pkg.mergedDocuments ? "on" : "off"}, ` +
      `ids=${pkg.identificationDocs}, aps=${pkg.apsDocs}, ` +
      `personal info for ${pkg.personalInfoPeople}, property rows=${pkg.propertyInfoRows}, ` +
      `task pdfs=${taskPdfCount}, documents=${docs.attachments.length}) ` +
      `linked=${docs.linked.length}`,
  );

  return {
    success: true,
    recipients,
    attached: attachments.length,
    linked: docs.linked.length,
    identification: pkg.identificationDocs,
    aps: pkg.apsDocs,
    personalInfo: pkg.personalInfoPeople,
    propertyInfo: pkg.propertyInfoRows,
  };
}
