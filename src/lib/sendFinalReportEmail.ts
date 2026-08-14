// Emails the final reporting package to the client(s) after closing.
//
// The wording lives in an `email_templates` row named "Final Reporting Package"
// — NOT in this file. Staff reword it from Templates → Emails without a deploy,
// and marking that template inactive is a real off-switch for the send.
//
// One email PER RECIPIENT rather than one shared email, so {{ user.first_name }}
// actually names the person reading it. On a Purchase & Sale file each
// co-person is only party to their own side, so both the address shown and the
// documents attached are scoped by `recipientSide` — the same rule the retainer
// sender uses (send-lead-family-email), which honours the authoritative
// `co_person_role`.

import { get } from "@vercel/blob";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { isPrivateBlobUrl, blobTokenForUrl } from "./blobPrivacy";
import { emailFrom, emailReplyTo } from "./emailIdentity";
import {
  decodeTemplateBraces,
  renderTemplateSafe,
  type TemplateValue,
} from "./renderEmailTemplate";
import {
  buildLeadAddressForEmail,
  buildLeadAddressPartsForEmail,
} from "./leadEmailAddress";

/** The `email_templates.name` staff must give the template. Substring, case-insensitive. */
export const FINAL_REPORT_TEMPLATE_NAME = "Final Reporting Package";

/** The doc_type these documents are stored under in `lead_corporate_docs`. */
export const FINAL_REPORT_DOC_TYPE = "final_report";

/**
 * The lead columns a recipient needs.
 *
 * One unbroken string literal on purpose: Supabase's typed client parses the
 * select at the type level, and a `+`-concatenated version is not a literal —
 * every row then infers as GenericStringError.
 */
export const FINAL_REPORT_LEAD_COLUMNS =
  "id, first_name, last_name, email, lead_type, parent_lead_id, co_person_role, address_street, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code";

interface RecipientLead {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  lead_type: string | null;
  parent_lead_id: string | null;
  co_person_role: string | null;
  address_street: string | null;
  address_city: string | null;
  address_province: string | null;
  address_postal_code: string | null;
  selling_address_street: string | null;
  selling_address_city: string | null;
  selling_address_province: string | null;
  selling_address_postal_code: string | null;
}

export interface FinalReportSendResult {
  sent: Array<{ email: string; documents: number }>;
  failed: Array<{ email: string; error: string }>;
  /** Set when nothing could be attempted at all. */
  error?: string;
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
 * Send the final reporting package for one deal.
 *
 * `recipientLeadIds` narrows the send to specific people; omit it to send to
 * everyone on the file who has an email address.
 */
export async function sendFinalReportEmail(opts: {
  /** Every lead in the family, already resolved by the caller. */
  leads: RecipientLead[];
  /** Restrict to these lead ids. Empty/undefined means all of them. */
  recipientLeadIds?: string[];
}): Promise<FinalReportSendResult> {
  const result: FinalReportSendResult = { sent: [], failed: [] };

  const targets = (opts.leads ?? []).filter((lead) => {
    if (!lead.email?.trim()) return false;
    if (opts.recipientLeadIds?.length) {
      return opts.recipientLeadIds.includes(lead.id);
    }
    return true;
  });

  if (targets.length === 0) {
    return { ...result, error: "No client on this file has an email address." };
  }

  // ── The template ──
  const { data: templates } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", `%${FINAL_REPORT_TEMPLATE_NAME}%`)
    .order("created_at", { ascending: false });

  const template = (templates ?? []).find((t) => t.is_active && !t.is_deleted);
  if (!template) {
    return {
      ...result,
      error: `No active "${FINAL_REPORT_TEMPLATE_NAME}" email template is configured. Add one under Templates → Emails.`,
    };
  }

  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = emailFrom();

  // Every final-report document on the file, across the whole family — a
  // co-purchaser's package may have been uploaded against the primary's lead.
  const familyLeadIds = opts.leads.map((l) => l.id);
  const { data: allDocs, error: docsErr } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_name, file_url, side")
    .in("lead_id", familyLeadIds)
    .eq("doc_type", FINAL_REPORT_DOC_TYPE);

  if (docsErr) {
    return { ...result, error: `Could not load the final report: ${docsErr.message}` };
  }
  const documents = (allDocs ?? []).filter((d) => Boolean(d.file_url));
  if (documents.length === 0) {
    return { ...result, error: "Upload a final report before emailing it." };
  }

  const sentDocIds = new Set<string>();

  for (const lead of targets) {
    const email = (lead.email ?? "").trim();
    try {
      const parts = await buildLeadAddressPartsForEmail(lead);
      const side = parts.recipientSide;

      // Scope to the side this person is party to. An untagged document is
      // legacy and applies to any side. If scoping would leave nothing —
      // mis-tagged data — fall back to everything rather than silently
      // sending an email with no package attached.
      let scoped = documents;
      if (side !== "combined") {
        const bySide = documents.filter((d) => {
          const s = (d.side ?? "").toLowerCase().trim();
          return s === side || s === "";
        });
        if (bySide.length > 0) scoped = bySide;
      }

      const attachments: Array<{ filename: string; content: Buffer }> = [];
      for (const doc of scoped) {
        attachments.push({
          filename: doc.file_name || "final-report.pdf",
          content: await downloadDoc(doc.file_url as string),
        });
      }

      const leadAddress = await buildLeadAddressForEmail(lead);
      const firstName = (lead.first_name ?? "").trim();
      const fullName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();

      // Keys are matched lowercased with leading dots stripped, so
      // "{{ user.first_name }}" resolves against "user.first_name".
      const values: Record<string, string> = {
        lead_address: leadAddress,
        property_address: leadAddress,
        "user.first_name": firstName,
        "user.last_name": (lead.last_name ?? "").trim(),
        "user.full_name": fullName,
        first_name: firstName,
        full_name: fullName,
        client_name: fullName,
      };

      const resolve = (name: string): TemplateValue | null => {
        const key = name.toLowerCase().replace(/^\.+/, "");
        if (!Object.prototype.hasOwnProperty.call(values, key)) return null;
        // Everything here is client-supplied, so it is all HTML-escaped.
        return { value: values[key] };
      };

      const html = renderTemplateSafe(decodeTemplateBraces(template.body), resolve);
      const subject = renderTemplateSafe(
        decodeTemplateBraces(template.subject || "Final Reporting Package"),
        resolve,
        { escape: false },
      );

      await resend.emails.send({
        from: fromEmail,
        replyTo: emailReplyTo(),
        to: [email],
        subject,
        html,
        attachments,
      });

      for (const doc of scoped) sentDocIds.add(doc.id);
      result.sent.push({ email, documents: attachments.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not send the email";
      logger.error(`[FinalReport] send failed for ${email}:`, message);
      result.failed.push({ email, error: message });
    }
  }

  // Stamp the documents that actually went out, so the UI can show when the
  // package was sent and to whom instead of leaving staff to guess.
  if (sentDocIds.size > 0 && result.sent.length > 0) {
    const { error: stampErr } = await supabaseAdmin
      .from("lead_corporate_docs")
      .update({
        emailed_at: new Date().toISOString(),
        emailed_to: result.sent.map((s) => s.email).join(", "),
      })
      .in("id", Array.from(sentDocIds));
    if (stampErr) {
      // The clients have their email; failing now would invite a re-send.
      logger.error("[FinalReport] could not stamp the send:", stampErr.message);
    }
  }

  return result;
}
