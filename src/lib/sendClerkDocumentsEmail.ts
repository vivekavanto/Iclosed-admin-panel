// "Email to clerk" — sends a file's whole client document package to the firm's
// conveyancing clerks.
//
// Sits next to "Download All" on the deal page and follows the same rule: the
// clerks asked for the original files as SEPARATE attachments, because merging
// them into one PDF mangles the source documents' own templates/formatting.
// (Download All zips them for the same reason.) So this reuses
// collectFamilyDocuments(), which hands back each stored blob untouched.
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

import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { collectFamilyDocuments, renderLinkedDocsHtml } from "./familyDocuments";
import { formatLeadTypeLabel, buildLeadAddressPartsForEmail, renderTransactionPhrase } from "./leadEmailAddress";
import { logger } from "./logger";
import { withRetry } from "./retry";

/** Firm defaults; override per-environment without a deploy. */
const DEFAULT_PURCHASE_CLERK = "purchase@navawilson.law";
const DEFAULT_SALE_CLERK = "sale@navawilson.law";

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

/**
 * Build the clerk email body in CODE rather than from an `email_templates` row.
 *
 * Template rows live in the shared database and are read by every environment
 * at once, while the code resolving their placeholders ships per-deploy — so a
 * template that references a new placeholder emails raw "{{ }}" syntax wherever
 * the code hasn't landed (this bit us on 2026-08-10). This is an internal
 * routing email with no client-facing wording to tune, so generating it here
 * keeps it correct in every environment. If staff later want it editable, add a
 * template row and fall back to this body when it's missing.
 */
function renderBody(opts: {
  partySummary: string;
  transaction: string;
  fileNumber: string;
  leadTypeLabel: string;
  closingDate: string;
  attached: number;
  dealUrl: string;
}): string {
  const { partySummary, transaction, fileNumber, leadTypeLabel, closingDate, attached, dealUrl } =
    opts;
  return (
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
    `<p>Hi,</p>` +
    `<p>Please find attached the client documents for <strong>${escapeHtml(partySummary)}</strong>` +
    `${transaction ? ` — ${escapeHtml(transaction)}` : ""}.</p>` +
    `<p>${attached} document${attached === 1 ? " is" : "s are"} attached as separate files.</p>` +
    `<p style="margin-top:24px;">` +
    `<a href="${dealUrl}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">` +
    `Open file ${escapeHtml(fileNumber)}</a></p>` +
    `<p style="color:#64748b;font-size:13px;margin-top:24px;">` +
    `File ${escapeHtml(fileNumber)} &middot; ${escapeHtml(leadTypeLabel)} &middot; Closing ${escapeHtml(closingDate)}` +
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

/** Send one deal family's document package to the appropriate clerk inbox(es). */
export async function sendClerkDocumentsEmail(dealId: string): Promise<ClerkEmailResult> {
  const empty: ClerkEmailResult = { success: false, recipients: [], attached: 0, linked: 0 };

  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, file_number, type, closing_date")
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

  const docs = await collectFamilyDocuments(dealIds, familyLeadIds, adminBaseUrl());
  if (docs.total === 0) {
    return { ...empty, error: "There are no uploaded documents on this file yet" };
  }

  const clientName = primaryLead ? fullName(primaryLead) : "";
  const coPartyNames = (familyLeads ?? [])
    .filter((l) => l.id !== primaryLead?.id)
    .map(fullName)
    .filter(Boolean);
  const partySummary = joinNames([clientName, ...coPartyNames]) || clientName || "Client";

  const leadTypeLabel = formatLeadTypeLabel(rawType);
  const addressParts = await buildLeadAddressPartsForEmail(primaryLead);
  const transaction = renderTransactionPhrase(addressParts, leadTypeLabel);
  const fileNumber = deal.file_number ?? "";
  const closingDate = formatClosingDate(deal.closing_date);

  const html =
    renderBody({
      partySummary,
      transaction,
      fileNumber,
      leadTypeLabel,
      closingDate,
      attached: docs.attachments.length,
      dealUrl: `${adminBaseUrl()}/admin/deals/${deal.id}`,
    }) + renderLinkedDocsHtml(docs.linked);

  const subject =
    `${fileNumber ? `${fileNumber} — ` : ""}Client documents` +
    `${partySummary ? ` — ${partySummary}` : ""}`;

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
      `attached=${docs.attachments.length} linked=${docs.linked.length}`,
  );

  return {
    success: true,
    recipients,
    attached: docs.attachments.length,
    linked: docs.linked.length,
  };
}
