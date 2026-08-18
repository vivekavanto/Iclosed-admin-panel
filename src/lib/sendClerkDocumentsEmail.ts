// "Email to clerk" — sends a file's whole client document package to the firm's
// conveyancing clerks.
//
// Sits next to "Download All" on the deal page and follows the same rule: the
// clerks asked for the original files as SEPARATE attachments, because merging
// them into one PDF mangles the source documents' own templates/formatting.
// (Download All zips them for the same reason.) So this reuses
// collectFamilyDocuments(), which hands back each stored blob untouched — only
// RENAMED into the firm's filing convention (see the naming note below).
//
// Routing: the clerk inbox is chosen by the file's type —
//   Purchase        → CLERK_PURCHASE_EMAIL
//   Sale            → CLERK_SALE_EMAIL
//   Purchase & Sale → BOTH, on one email (not two), so the attachments are
//                     transferred once and the two clerks can see each other on
//                     the thread.
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

import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { collectFamilyDocuments, renderLinkedDocsHtml } from "./familyDocuments";
import { formatLeadTypeLabel, buildLeadAddressPartsForEmail, renderTransactionPhrase } from "./leadEmailAddress";
import { decodeTemplateBraces, renderTemplateSafe, type TemplateValue } from "./renderEmailTemplate";
import { logger } from "./logger";
import { withRetry } from "./retry";

/** Firm defaults; override per-environment without a deploy. */
const DEFAULT_PURCHASE_CLERK = "purchase@navawilson.law";
const DEFAULT_SALE_CLERK = "sale@navawilson.law";

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
  /** How many documents were attached as individual files. */
  attached: number;
  /** Documents too large to attach, sent as links instead. */
  linked: number;
  error?: string;
};

/** Absolute link back into the admin portal for the email CTA. */
function adminBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Which clerk inbox(es) this file belongs to.
 *
 * Matches the same "combined means both" rule as formatLeadTypeLabel: anything
 * naming both purchase and sale is a P&S file. A type we don't recognise
 * (Refinance, blank) returns [] and the caller refuses to send rather than
 * guessing an inbox.
 */
export function clerkRecipientsForType(rawType: string | null | undefined): string[] {
  const purchase = splitAddresses(process.env.CLERK_PURCHASE_EMAIL || DEFAULT_PURCHASE_CLERK);
  const sale = splitAddresses(process.env.CLERK_SALE_EMAIL || DEFAULT_SALE_CLERK);

  const lt = (rawType ?? "").toLowerCase().trim();
  const hasPurchase = lt.includes("purchase");
  const hasSale = lt.includes("sale");

  if (hasPurchase && hasSale) return Array.from(new Set([...purchase, ...sale]));
  if (hasSale) return sale;
  if (hasPurchase) return purchase;
  return [];
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
    `<p>${f.attached} document${f.attached === 1 ? " is" : "s are"} attached as separate files.</p>` +
    `<p style="margin-top:24px;">` +
    `<a href="${f.dealUrl}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">` +
    `Open file ${escapeHtml(f.fileNumber)}</a></p>` +
    `<p style="color:#64748b;font-size:13px;margin-top:24px;">` +
    `File ${escapeHtml(f.fileNumber)} &middot; ${escapeHtml(f.leadTypeLabel)} &middot; Closing ${escapeHtml(f.closingDate)}` +
    `</p></div>`
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
  const empty: ClerkEmailResult = { success: false, recipients: [], attached: 0, linked: 0 };

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
  const recipients = clerkRecipientsForType(rawType);
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

  // Renames each attachment to "<file number> - <task name> - <client name>",
  // APS uploads excepted.
  const docs = await collectFamilyDocuments(dealIds, familyLeadIds, adminBaseUrl(), {
    fileNumber,
  });
  if (docs.total === 0) {
    return { ...empty, error: "There are no uploaded documents on this file yet" };
  }

  const clientName = primaryLead ? fullName(primaryLead) : "";
  const coPartyNames = (familyLeads ?? [])
    .filter((l) => l.id !== primaryLead?.id)
    .map(fullName)
    .filter(Boolean);
  const clientNameList = [clientName, ...coPartyNames].filter(Boolean);
  const clientNames = joinNames(clientNameList) || clientName || "Client";

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
    attached: docs.attachments.length,
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
    attached_count: String(docs.attachments.length),
    linked_count: String(docs.linked.length),
    document_count: String(docs.total),
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
      : renderBody(facts)) + renderLinkedDocsHtml(docs.linked);

  const subject = template?.subject?.trim()
    ? renderTemplateSafe(template.subject, resolve, { escape: false })
    : defaultSubject(facts);

  if (!process.env.RESEND_API_KEY) {
    return { ...empty, error: "Email is not configured (RESEND_API_KEY missing)" };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  try {
    await withRetry(
      async () => {
        const { data, error } = await resend.emails.send({
          from: fromEmail,
          to: recipients,
          subject,
          html,
          ...(docs.attachments.length > 0 ? { attachments: docs.attachments } : {}),
        });
        if (error) throw new Error(error.message);
        return data;
      },
      { attempts: 3, label: "clerk-documents-email" },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[ClerkDocuments] send failed — deal=${dealId}:`, err);
    return { ...empty, error: `Could not send the email: ${message}` };
  }

  logger.info(
    `[ClerkDocuments] sent deal=${dealId} file=${fileNumber} to=${recipients.join(", ")} ` +
      `template=${template ? "db" : "built-in"} ` +
      `attached=${docs.attachments.length} linked=${docs.linked.length}`,
  );

  return {
    success: true,
    recipients,
    attached: docs.attachments.length,
    linked: docs.linked.length,
  };
}
