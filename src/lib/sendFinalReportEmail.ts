// Emails the final reporting package to the client(s) after closing.
//
// The wording lives in an `email_templates` row named "Final Reporting Package"
// — NOT in this file. Staff reword it from Templates → Emails without a deploy,
// and marking that template inactive is a real off-switch for the send.
//
// ONE email to everyone who gets the same package, with every address in `to` —
// not one email each. Three co-purchasers on a file used to receive three
// separate copies of an identical email, which reads to a client like a mistake.
// {{ user.first_name }} then names all of them ("Aliya, Rehana and John"), the
// same way a combined milestone email does (see sendMilestoneEmail).
//
// Recipients are grouped by the package they are entitled to, NOT lumped
// together unconditionally. On a Purchase & Sale file each co-person is party
// to their own side only, so the documents attached — and the address shown —
// are scoped by `recipientSide`, honouring the authoritative `co_person_role`
// the same way the retainer sender does. Two people owed different documents
// therefore still get two emails; two people owed the same one get one.

import { get } from "@vercel/blob";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { isPrivateBlobUrl, blobTokenForUrl } from "./blobPrivacy";
import { emailFrom, emailReplyTo } from "./emailIdentity";
import { getLeadFirmKey } from "./leadFirm";
import { brandEmailHtml } from "./emailBrand";
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

/** "Alice" / "Alice and Bob" / "Alice, Bob and Carol". */
function joinNames(names: string[]): string {
  const clean = names.map((n) => n.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
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
  // One firm per file; `opts.leads` is that one file's family.
  const firm = await getLeadFirmKey(opts.leads?.[0]?.id ?? null);
  const fromEmail = emailFrom(firm);

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

  // ── Who shares an email ──
  // The package a person is entitled to decides it: everyone owed the SAME
  // documents is on one email together. On a single-side file that is the whole
  // family; on a Purchase & Sale file the purchase side and the sale side are
  // owed different documents, so they stay apart.
  type Group = {
    leads: RecipientLead[];
    documents: typeof documents;
  };
  const groups = new Map<string, Group>();

  for (const lead of targets) {
    const parts = await buildLeadAddressPartsForEmail(lead);
    const side = parts.recipientSide;

    // Scope to the side this person is party to. An untagged document is legacy
    // and applies to any side. If scoping would leave nothing — mis-tagged data
    // — fall back to everything rather than silently sending an email with no
    // package attached.
    let scoped = documents;
    if (side !== "combined") {
      const bySide = documents.filter((d) => {
        const s = (d.side ?? "").toLowerCase().trim();
        return s === side || s === "";
      });
      if (bySide.length > 0) scoped = bySide;
    }

    // Keyed by the documents themselves rather than by side: two sides that
    // resolve to the same package (a file with only untagged documents) belong
    // on one email, and two people on the same side with different packages
    // could never share one.
    const key = scoped
      .map((d) => d.id)
      .sort()
      .join("|");
    const existing = groups.get(key);
    if (existing) existing.leads.push(lead);
    else groups.set(key, { leads: [lead], documents: scoped });
  }

  for (const group of groups.values()) {
    // The primary anchors the address and leads the greeting — the same
    // convention the combined milestone email uses. A co-person's row can hold
    // only their own side, so reading the address off the primary keeps it
    // whole.
    const ordered = [...group.leads].sort((a, b) => {
      const aPrimary = a.parent_lead_id ? 1 : 0;
      const bPrimary = b.parent_lead_id ? 1 : 0;
      return aPrimary - bPrimary;
    });
    const anchor = ordered[0];
    const emails = ordered.map((l) => (l.email ?? "").trim()).filter(Boolean);
    // The same person twice — a co-client sharing their partner's inbox —
    // would otherwise put one address in `to` twice.
    const to = Array.from(new Set(emails.map((e) => e.toLowerCase()))).map(
      (lower) => emails.find((e) => e.toLowerCase() === lower) as string,
    );

    try {
      const attachments: Array<{ filename: string; content: Buffer }> = [];
      for (const doc of group.documents) {
        attachments.push({
          filename: doc.file_name || "final-report.pdf",
          content: await downloadDoc(doc.file_url as string),
        });
      }

      const leadAddress = await buildLeadAddressForEmail(anchor);
      // "Aliya" / "Aliya and Rehana" / "Aliya, Rehana and John". Surnames dedupe
      // — a married couple is "Hanief", not "Hanief and Hanief" — while first
      // names never do: two people who share one still need both listed.
      const firstName = joinNames(ordered.map((l) => (l.first_name ?? "").trim()));
      const lastName = joinNames(
        Array.from(new Set(ordered.map((l) => (l.last_name ?? "").trim()).filter(Boolean))),
      );
      const fullName = joinNames(
        ordered.map((l) => `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim()),
      );

      // Keys are matched lowercased with leading dots stripped, so
      // "{{ user.first_name }}" resolves against "user.first_name".
      const values: Record<string, string> = {
        lead_address: leadAddress,
        property_address: leadAddress,
        "user.first_name": firstName,
        "user.last_name": lastName,
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
        replyTo: emailReplyTo(firm),
        to,
        subject,
        html: brandEmailHtml(html, firm),
        attachments,
      });

      for (const doc of group.documents) sentDocIds.add(doc.id);
      // One entry per ADDRESS, not per email sent: the audit log, the toast and
      // the "emailed to" stamp all read as "who received the package".
      for (const email of to) {
        result.sent.push({ email, documents: attachments.length });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not send the email";
      logger.error(`[FinalReport] send failed for ${to.join(", ")}:`, message);
      for (const email of to) result.failed.push({ email, error: message });
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
