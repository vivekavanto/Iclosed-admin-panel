import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import {
  formatLeadTypeLabel,
  buildLeadAddressPartsForEmail,
  renderTransactionPhrase,
} from "./leadEmailAddress";
import {
  renderTemplateSafe,
  escapeHtml,
  decodeTemplateBraces,
  type TemplateValue,
} from "./renderEmailTemplate";
import { maskEmail } from "./maskEmail";
import { logger } from "./logger";
import { withRetry } from "./retry";
import { EMAIL_REPLY_TO } from "./emailConfig";

export type WelcomeEmailResult = {
  success: boolean;
  alreadySent?: boolean;
  skipped?: boolean;
  skipReason?: string;
  emailId?: string;
  templateUsed?: string;
  error?: string;
  statusCode?: number;
};

export type WelcomeEmailOpts = {
  /**
   * Where this trigger fires. Used only for logging.
   * - "intake"     → fired right after Intake form submission
   * - "conversion" → fired when admin converts a lead to a deal
   * - "first_login" → legacy webhook from customer portal first login
   * - "manual"    → admin clicked the Send Welcome Email button
   */
  source?: "intake" | "conversion" | "first_login" | "manual";

  /**
   * Optional explicit template selection. If omitted we look up by name
   * containing "welcome" (case-insensitive) among active templates.
   */
  templateId?: string;
  templateName?: string;

  /**
   * When true, skip the `welcome_email_sent` idempotency guard. Used by the
   * manual admin Send-Email-to-Family flow which may need to re-send to family
   * members who already had a welcome email triggered automatically at
   * conversion. Auto-triggers (intake / conversion / first_login) must leave
   * this false so they remain idempotent.
   */
  bypassIdempotency?: boolean;
};

// Maps a lead's lead_type + parent_lead_id into a human role string used by
// {{ property_role_row }}. Mirrors the getCoRole logic in components/Leads.tsx.
function computeRole(lead: any): string {
  const lt = (lead.lead_type ?? "").toLowerCase().trim();
  const isCombined = lt.includes("purchase") && lt.includes("sale");
  const isSaleOnly = lt === "sale" || (lt.includes("sale") && !lt.includes("purchase"));

  if (lead.parent_lead_id) {
    // Co-lead — pick side from own lead_type, then from selling_address_street fallback.
    if (isSaleOnly) return "Co-Seller";
    if (isCombined && lead.selling_address_street) return "Co-Seller";
    if (lt.includes("purchase") && !isSaleOnly) return "Co-Purchaser";
    if (lead.selling_address_street) return "Co-Seller";
    return "Co-Purchaser";
  }
  if (isCombined) return "Purchaser & Seller";
  if (isSaleOnly) return "Seller";
  return "Purchaser";
}

export async function interpolate(
  text: string,
  lead: any,
  fileNumber: string | null = null,
  opts: { escape?: boolean } = {},
): Promise<string> {
  // escape=true for HTML bodies (default); callers pass escape:false for the
  // plain-text subject line so escaped entities don't show literally.
  const escape = opts.escape !== false;
  const firstName = lead.first_name ?? "";
  const lastName = lead.last_name ?? "";
  const fullName = `${firstName} ${lastName}`.trim();
  const email = lead.email ?? "";
  // Centralized address+type formatting — combines purchase & selling for
  // P&S, with a family-sibling fallback for split families. See
  // src/lib/leadEmailAddress.ts.
  const addressParts = await buildLeadAddressPartsForEmail(lead);
  const address = addressParts.treatAsCombined
    ? [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ")
    : addressParts.typeIsSaleOnly
      ? (addressParts.selling || addressParts.purchase)
      : addressParts.purchase;
  const leadType = formatLeadTypeLabel(lead.lead_type);
  const transactionPhrase = renderTransactionPhrase(addressParts, leadType);
  const resolvedFileNumber = fileNumber ?? lead.file_number ?? "";

  // Side suffix for subject lines, scoped to the side THIS recipient sees:
  // combined primary → " (Purchase & Sale)", any seller (incl. co-seller) →
  // " (Sale)", purchaser / co-purchaser → "" so the subject stays clean.
  // Driven by recipientSide (which honors co_person_role) rather than the raw
  // lead_type, so a co-lead on a Purchase & Sale family gets only their side.
  const sideSuffix = addressParts.recipientSide === "combined"
    ? " (Purchase & Sale)"
    : addressParts.recipientSide === "sale"
      ? " (Sale)"
      : "";

  // Pre-rendered "Your Role: <role>" line for the body. If no useful role can
  // be determined the line collapses to empty so the email doesn't show a
  // stray label.
  const role = computeRole(lead);
  const propertyRoleRow = role ? `Your Role: ${role}` : "";

  // Normalized placeholder → value lookup. Keys are lowercased and have any
  // leading dot stripped, so every spacing/case/alias variant the old map listed
  // explicitly (user.*, client.*, short-form, {{NAME}}, {{LEAD_TYPE}},
  // {{CLIENT_ADDRESS}}) collapses to one entry. The single-pass renderer trims
  // and lowercases each token before lookup, so whitespace tolerance is built in.
  const values: Record<string, string> = {
    "user.first_name": firstName,
    "client.first_name": firstName,
    "first_name": firstName,
    "user.last_name": lastName,
    "client.last_name": lastName,
    "last_name": lastName,
    "user.full_name": fullName,
    "user.get_full_name": fullName,
    "client.full_name": fullName,
    "client.get_full_name": fullName,
    "full_name": fullName,
    "name": fullName,
    "user.email": email,
    "client.email": email,
    "email": email,
    "lead_address": address,
    "property_address": address,
    "client_address": address,
    "lead.address_line1": lead.address_street ?? "",
    "lead.address_city": lead.address_city ?? "",
    "lead.address_province": lead.address_province ?? "",
    "lead.file_number": resolvedFileNumber,
    "file_number": resolvedFileNumber,
    "lead_type": leadType,
    "stage_name": "",
    "stage_status": "",
    "side_suffix": sideSuffix,
    "property_role_row": propertyRoleRow,
  };

  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key)
      ? { value: values[key] }
      : null;
  };

  // Pair-up pattern: "{{ lead_type }} of {{ lead_address }}" must render as
  // "Purchase of <P> and Sale of <S>" for combined files, not
  // "Purchase & Sale of <P> and <S>" which collapses the two sides. Resolve the
  // whole phrase first; it embeds the (user-controlled) address, so escape it
  // when escaping. It is brace-free, so the single pass below won't re-scan it.
  const result = text.replace(
    /\{\{\s*lead_type\s*\}\}\s+of\s+\{\{\s*lead_address\s*\}\}/gi,
    () => (escape ? escapeHtml(transactionPhrase) : transactionPhrase),
  );

  return renderTemplateSafe(result, resolve, { escape });
}

/**
 * Sends the welcome email to a lead. Idempotent — if `welcome_email_sent` is
 * already true on the lead, this returns success without re-sending.
 *
 * Safe to call from multiple triggers (intake submission, conversion,
 * first-login webhook, manual admin send) — only the first one actually
 * sends.
 */
export async function sendWelcomeEmail(
  leadId: string,
  opts: WelcomeEmailOpts = {},
): Promise<WelcomeEmailResult> {
  if (!leadId) {
    return { success: false, error: "lead_id is required", statusCode: 400 };
  }

  // 1. Fetch the lead
  const { data: lead, error: leadError } = await supabaseAdmin
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .single();

  if (leadError || !lead) {
    return { success: false, error: "Lead not found", statusCode: 404 };
  }

  if (!lead.email) {
    return { success: false, error: "Lead has no email address", statusCode: 400 };
  }

  // 2. Idempotency guard
  if (lead.welcome_email_sent && !opts.bypassIdempotency) {
    return { success: true, alreadySent: true, templateUsed: "(already sent)" };
  }

  // 3. Resolve which file_number to use (deal's file_number if converted)
  let fileNumber: string | null = null;
  const { data: relatedDeal } = await supabaseAdmin
    .from("deals")
    .select("file_number")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (relatedDeal?.file_number) fileNumber = relatedDeal.file_number;

  // 4. Pick template — strict is_active handling.
  // If admin marked the matching template inactive, we skip the send entirely
  // instead of falling back to the default body. This makes the inactive
  // toggle a real off-switch.
  let template: any = null;

  if (opts.templateId) {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .eq("id", opts.templateId)
      .single();
    if (data && !data.is_active) {
      logger.info(
        `[Welcome Email] Skipped — template "${data.name}" (id=${data.id}) is inactive. lead=${leadId} source=${opts.source ?? "unknown"}`,
      );
      return {
        success: true,
        skipped: true,
        skipReason: `Template "${data.name}" is inactive`,
        templateUsed: data.name,
      };
    }
    if (data) template = data;
  }

  if (!template) {
    const searchName = (opts.templateName || "welcome").toLowerCase();

    // Pull any matching template (active or inactive) so we can distinguish
    // "no welcome template configured" from "welcome template intentionally
    // disabled".
    const { data: matching } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .ilike("name", `%${searchName}%`)
      .order("created_at", { ascending: false });

    if (matching && matching.length > 0) {
      const active = matching.find((t: any) => t.is_active);
      if (!active) {
        logger.info(
          `[Welcome Email] Skipped — all matching templates (name~"${searchName}") are inactive. lead=${leadId} source=${opts.source ?? "unknown"}`,
        );
        return {
          success: true,
          skipped: true,
          skipReason: `Welcome template is inactive`,
          templateUsed: matching[0]?.name,
        };
      }
      template = active;
    }
  }

  // No template configured — skip the send entirely. The hardcoded
  // fallback body has been removed; admins must create a "Welcome"
  // template in /admin/templates/emails (or run the seed migration)
  // before this email can fire.
  if (!template?.body || template.body.trim() === "") {
    logger.info(
      `[Welcome Email] Skipped — no welcome template configured. lead=${leadId} source=${opts.source ?? "unknown"}`,
    );
    return {
      success: true,
      skipped: true,
      skipReason: "No welcome template configured",
    };
  }

  // 5. Build body
  // GAP-013: decode all brace encodings (decimal/hex/named) so placeholders
  // are recognized regardless of how the template editor stored them.
  const rawBody = decodeTemplateBraces(template.body)
    .replace(/ /g, " ");

  const emailBody = await interpolate(rawBody, lead, fileNumber);

  // No HTML wrapper / logo injection — the DB template owns its layout.
  // Admins can include their own logo or footer inside the template body.
  const htmlBody = emailBody;

  // 6. Subject — derived from the template only (no hardcoded fallback).
  // Template name is required, so it always has a value.
  const rawSubject =
    template.subject && template.subject.trim() !== ""
      ? template.subject
      : template.name;
  // Subject is plain text — don't HTML-escape (single-pass still applies).
  const subject = await interpolate(rawSubject, lead, fileNumber, {
    escape: false,
  });

  // 7. Send
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)", statusCode: 500 };
  }

  // GAP-011: atomically CLAIM the send BEFORE calling Resend so two concurrent
  // triggers can't both send. Only the caller that flips welcome_email_sent
  // false→true wins the claim; a loser skips. If the send then fails we revert
  // the flag so a later retry can send. (Skipped for a deliberate manual re-send.)
  let claimedSend = false;
  if (!opts.bypassIdempotency) {
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("leads")
      .update({ welcome_email_sent: true })
      .eq("id", leadId)
      .eq("welcome_email_sent", false)
      .select("id");
    if (claimErr) {
      return { success: false, error: "Failed to reserve welcome email send", statusCode: 500 };
    }
    if (!claimed || claimed.length === 0) {
      // Another trigger already claimed/sent it — don't send a duplicate.
      return { success: true, alreadySent: true, templateUsed: "(already sent)" };
    }
    claimedSend = true;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  // GAP-012: retry the send a few times with backoff so a transient Resend/API
  // blip doesn't drop the welcome email. Resend returns { error } instead of
  // throwing, so we throw on error to drive the retry.
  let sendResult: { id?: string } | null = null;
  try {
    sendResult = await withRetry(
      async () => {
        const { data, error } = await resend.emails.send({
          from: fromEmail,
          replyTo: EMAIL_REPLY_TO,
          to: [lead.email],
          subject,
          html: htmlBody,
        });
        if (error) throw new Error(error.message);
        return data;
      },
      { attempts: 3, label: "welcome-email" },
    );
  } catch (sendErr: any) {
    logger.error(
      `[Welcome Email] Resend failed after retries (source=${opts.source ?? "unknown"}):`,
      sendErr,
    );
    // GAP-011: the send failed — release the claim so a later retry can send.
    if (claimedSend) {
      await supabaseAdmin
        .from("leads")
        .update({ welcome_email_sent: false })
        .eq("id", leadId);
    }
    return {
      success: false,
      error: `Email send failed: ${sendErr?.message ?? "unknown error"}`,
      statusCode: 500,
    };
  }

  // 8. Mark sent. When we claimed above, the flag is already true; this only
  // matters for the bypassIdempotency (manual re-send) path, which didn't claim.
  if (!claimedSend) {
    const { error: updateError } = await supabaseAdmin
      .from("leads")
      .update({ welcome_email_sent: true })
      .eq("id", leadId);
    if (updateError) {
      console.error("[Welcome Email] Failed to update welcome_email_sent:", updateError);
    }
  }

  // SEC-022/CMP-008: mask the recipient and omit the subject (it contains the
  // customer's name/address) so PII isn't written to server logs.
  logger.info(
    `[Welcome Email] Sent to ${maskEmail(lead.email)} (source=${opts.source ?? "unknown"}), id=${sendResult?.id}`,
  );

  return {
    success: true,
    emailId: sendResult?.id,
    templateUsed: template?.name ?? "Default Welcome",
  };
}
