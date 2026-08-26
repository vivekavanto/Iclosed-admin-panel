// Tells the conveyancing clerks that a purchaser has sent their closing funds.
//
// Fired when the CLIENT completes "Deposit Funds Into Our Trust Account" in the
// portal. The client's app can't send this itself — the proof has to be attached
// and only this repo has the blob-download plumbing — so the portal posts the
// signed /api/webhooks/deposit-proof webhook, which calls this. Same shape as
// the all-tasks-complete alert, and for the same reason: an alert about a
// document that doesn't carry the document is the one nobody can act on.
//
// Recipients: the purchase clerk (CLERK_PURCHASE_EMAIL, shared with the "Email
// to Clerk" send) plus bookkeeping, who need every deposit regardless of side.
// Bookkeeping is ALWAYS on the email — money reaching the trust account is
// their record to keep, not the clerk's.
//
// Finding the proof is deliberately belt-and-braces. The obvious source is the
// task's own `task_responses` row, but file responses frequently carry only a
// file_name with a null file_url, so a doc_type lookup in `lead_corporate_docs`
// backs it up. If neither turns up bytes the email still goes — a clerk being
// told "the deposit is in, the attachment failed" beats silence.
//
// Wording lives in the "Deposit Proof Received" row of `email_templates`, with
// the built-in copy below as the fallback.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getFamilyDealIds } from "./familyDeals";
import { resolvePrimaryDealId } from "./primaryDeal";
import { emailFrom, emailReplyTo } from "./emailIdentity";
import { formatCurrency } from "./formatCurrency";
import { clerkRecipientsForType } from "./sendClerkDocumentsEmail";
import { readBlobDocument } from "./blobDocument";
import { PROOF_OF_DEPOSIT_DOC_TYPE, isDepositTask } from "./depositTask";
import {
  formatLeadTypeLabel,
  buildLeadAddressPartsForEmail,
  renderTransactionPhrase,
} from "./leadEmailAddress";
import {
  decodeTemplateBraces,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";
import { withRetry } from "./retry";

/** `email_templates.name` that owns the wording. Substring, case-insensitive. */
export const DEPOSIT_PROOF_TEMPLATE_NAME = "Deposit Proof Received";

/**
 * Always copied, on every file. Override per-environment with
 * DEPOSIT_BOOKKEEPING_EMAIL (comma-separated); set it to "off" to drop them.
 */
const DEFAULT_BOOKKEEPING = "bookkeeping@navawilson.law";

export type DepositProofResult = {
  sent: boolean;
  recipients?: string[];
  attached?: number;
  reason?:
    | "task_not_found"
    | "not_deposit_task"
    | "not_completed"
    | "no_recipients"
    | "email_not_configured"
    | "error";
};

function splitAddresses(raw: string | null | undefined): string[] {
  return Array.from(
    new Set(
      (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );
}

function bookkeepingRecipients(): string[] {
  const configured = (process.env.DEPOSIT_BOOKKEEPING_EMAIL ?? DEFAULT_BOOKKEEPING).trim();
  if (!configured || configured.toLowerCase() === "off") return [];
  return splitAddresses(configured);
}

function adminBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/** `deals.closing_date` is a DATE — format its parts in UTC, not as a Date. */
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

function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

function fallbackBody(v: Record<string, string>, attached: number): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi,</p>
  <p><strong>${v.client_names}</strong> has uploaded proof of deposit for ${v.transaction}.</p>
  <p style="margin:0 0 4px;"><strong>Balance due on closing:</strong> ${v.balance_due}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> ${v.closing_date}</p>
  <p>${attached > 0 ? "The document is attached." : "The document could not be attached — open the file to view it."}</p>
  <p style="margin-top:24px;">
    <a href="${v.deal_url}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open file ${v.file_number}
    </a>
  </p>
</div>`;
}

/**
 * The bytes the client uploaded.
 *
 * Both stores are read: the task's file responses first (authoritative — it is
 * the answer to THIS task), then any proof_of_deposit document on the family, so
 * a response row that recorded only a file name still finds its document.
 */
async function collectProof(
  taskId: string,
  familyLeadIds: string[],
): Promise<Array<{ filename: string; content: Buffer }>> {
  const urls = new Map<string, string>(); // file_url -> filename

  const { data: responses } = await supabaseAdmin
    .from("task_responses")
    .select("file_url, file_name, field_type")
    .eq("task_id", taskId)
    .eq("field_type", "file");

  for (const r of responses ?? []) {
    if (r.file_url) urls.set(r.file_url, r.file_name || "proof-of-deposit");
  }

  if (familyLeadIds.length > 0) {
    const { data: docs } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("file_url, file_name, created_at")
      .in("lead_id", familyLeadIds)
      .eq("doc_type", PROOF_OF_DEPOSIT_DOC_TYPE)
      .order("created_at", { ascending: false });

    for (const d of docs ?? []) {
      if (d.file_url && !urls.has(d.file_url)) {
        urls.set(d.file_url, d.file_name || "proof-of-deposit");
      }
    }
  }

  const attachments: Array<{ filename: string; content: Buffer }> = [];
  for (const [url, filename] of urls) {
    try {
      const { bytes } = await readBlobDocument(url);
      attachments.push({ filename, content: bytes });
    } catch (err) {
      logger.warn(`[DepositProof] could not download ${filename}:`, err);
    }
  }
  return attachments;
}

/**
 * Send the clerk alert for one completed deposit task.
 *
 * Best-effort by contract: never throws, so it can't fail the client's
 * submission or the webhook that triggered it.
 */
export async function sendDepositProofEmail(taskId: string): Promise<DepositProofResult> {
  try {
    const { data: task } = await supabaseAdmin
      .from("tasks")
      .select("id, title, deal_id, status, completed, balance_due")
      .eq("id", taskId)
      .eq("is_deleted", false)
      .maybeSingle();

    if (!task) return { sent: false, reason: "task_not_found" };
    if (!isDepositTask(task.title)) return { sent: false, reason: "not_deposit_task" };
    // The webhook fires on completion, but re-check rather than trust the
    // caller: this email announces money arriving.
    if (task.status !== "Completed" && task.completed !== true) {
      return { sent: false, reason: "not_completed" };
    }

    const primaryDealId = await resolvePrimaryDealId(task.deal_id);
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id, type, file_number, closing_date, property_address, lead_id")
      .eq("id", primaryDealId)
      .maybeSingle();

    const recipients = Array.from(
      new Set([...clerkRecipientsForType(deal?.type), ...bookkeepingRecipients()]),
    );
    if (recipients.length === 0) return { sent: false, reason: "no_recipients" };
    if (!process.env.RESEND_API_KEY) return { sent: false, reason: "email_not_configured" };

    // The family: names for the body, lead ids for the document fallback.
    const familyDealIds = await getFamilyDealIds(primaryDealId);
    const { data: familyDeals } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .in("id", familyDealIds)
      .eq("is_deleted", false);
    const leadIds = [
      ...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
    ];

    const { data: leads } = leadIds.length
      ? await supabaseAdmin
          .from("leads")
          .select(
            "id, first_name, last_name, lead_type, parent_lead_id, co_person_role, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code",
          )
          .in("id", leadIds)
          .eq("is_deleted", false)
          .order("parent_lead_id", { ascending: true, nullsFirst: true })
      : { data: [] as never[] };

    const ordered = leads ?? [];
    const primaryLead = ordered.find((l) => !l.parent_lead_id) ?? ordered[0] ?? null;

    const leadTypeLabel = formatLeadTypeLabel(primaryLead?.lead_type ?? deal?.type);
    const addressParts = await buildLeadAddressPartsForEmail(primaryLead);
    const propertyAddress =
      [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ") ||
      deal?.property_address ||
      "";
    const streetOf = (joined: string) => (joined.split(",")[0] ?? "").trim();
    const propertyStreet =
      streetOf(addressParts.purchase) || streetOf(propertyAddress) || "";
    const transaction =
      renderTransactionPhrase(addressParts, leadTypeLabel) ||
      (propertyAddress ? `${leadTypeLabel} of ${propertyAddress}`.trim() : "");

    const attachments = await collectProof(task.id, leadIds);

    const values: Record<string, string> = {
      client_names: joinNames(
        ordered.map((l) => `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim()),
      ),
      client_name: `${primaryLead?.first_name ?? ""} ${primaryLead?.last_name ?? ""}`.trim(),
      balance_due: formatCurrency(
        task.balance_due === null || task.balance_due === undefined
          ? null
          : Number(task.balance_due),
      ),
      transaction,
      property_address: propertyAddress,
      property_street: propertyStreet,
      closing_date: formatClosingDate(deal?.closing_date),
      file_number: deal?.file_number ?? "",
      lead_type: leadTypeLabel,
      attached_count: String(attachments.length),
      deal_url: `${adminBaseUrl()}/admin/deals/${primaryDealId}`,
    };

    const resolve = (name: string): TemplateValue | null => {
      const key = name.toLowerCase().replace(/^\.+/, "");
      if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
      return { value: values[key] };
    };

    const { data: templates } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .ilike("name", `%${DEPOSIT_PROOF_TEMPLATE_NAME}%`)
      .order("created_at", { ascending: false });
    const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted && t.body);

    const html = template
      ? renderTemplateSafe(decodeTemplateBraces(template.body), resolve)
      : fallbackBody(values, attachments.length);
    const subject = renderTemplateSafe(
      decodeTemplateBraces(
        template?.subject ||
          `Proof of deposit received — ${propertyStreet || values.file_number}`,
      ),
      resolve,
      { escape: false },
    );

    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await withRetry(() =>
      resend.emails.send({
        from: emailFrom(),
        replyTo: emailReplyTo(),
        to: recipients,
        subject,
        html,
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    );

    logger.info(
      `[DepositProof] task=${task.id} sent to ${recipients.join(", ")} attachments=${attachments.length}`,
    );
    return { sent: true, recipients, attached: attachments.length };
  } catch (err) {
    logger.error("[DepositProof] send failed:", err);
    return { sent: false, reason: "error" };
  }
}
