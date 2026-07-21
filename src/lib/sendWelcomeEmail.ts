import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import {
  formatLeadTypeLabel,
  buildLeadAddressPartsForEmail,
  renderTransactionPhrase,
} from "./leadEmailAddress";

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

export async function interpolate(text: string, lead: any, fileNumber: string | null = null): Promise<string> {
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

  const map: Record<string, string> = {
    // Canonical, namespaced placeholders
    "{{ user.first_name }}": firstName,
    "{{ user.last_name }}": lastName,
    "{{ user.get_full_name }}": fullName,
    "{{ user.full_name }}": fullName,
    "{{ user.email }}": email,
    "{{ lead_address }}": address,
    "{{ lead.address_line1 }}": lead.address_street ?? "",
    "{{ lead.address_city }}": lead.address_city ?? "",
    "{{ lead.address_province }}": lead.address_province ?? "",
    "{{ lead.file_number }}": resolvedFileNumber,
    "{{ lead_type }}": leadType,
    "{{ stage_name }}": "",
    "{{ stage_status }}": "",
    "{{user.first_name}}": firstName,
    "{{user.last_name}}": lastName,
    "{{user.get_full_name}}": fullName,
    "{{user.full_name}}": fullName,
    "{{user.email}}": email,
    "{{lead_address}}": address,
    "{{lead.address_line1}}": lead.address_street ?? "",
    "{{lead.address_city}}": lead.address_city ?? "",
    "{{lead.address_province}}": lead.address_province ?? "",
    "{{lead.file_number}}": resolvedFileNumber,
    "{{lead_type}}": leadType,
    // Short-form aliases (used by retainer-agreement and similar templates)
    "{{ first_name }}": firstName,
    "{{ last_name }}": lastName,
    "{{ full_name }}": fullName,
    "{{ email }}": email,
    "{{ property_address }}": address,
    "{{ file_number }}": resolvedFileNumber,
    "{{ side_suffix }}": sideSuffix,
    "{{ property_role_row }}": propertyRoleRow,
    "{{first_name}}": firstName,
    "{{last_name}}": lastName,
    "{{full_name}}": fullName,
    "{{email}}": email,
    "{{property_address}}": address,
    "{{file_number}}": resolvedFileNumber,
    "{{side_suffix}}": sideSuffix,
    "{{property_role_row}}": propertyRoleRow,
    "{{NAME}}": fullName,
    "{{LEAD_TYPE}}": leadType,
    "{{CLIENT_ADDRESS}}": address,
  };

  let result = text;

  // Pair-up pattern: "{{ lead_type }} of {{ lead_address }}" must render as
  // "Purchase of <P> and Sale of <S>" for combined files, not
  // "Purchase & Sale of <P> and <S>" which collapses the two sides. Replace
  // the whole phrase before the individual placeholders run.
  result = result.replace(
    /\{\{\s*lead_type\s*\}\}\s+of\s+\{\{\s*lead_address\s*\}\}/gi,
    transactionPhrase,
  );

  for (const [key, value] of Object.entries(map)) {
    result = result.split(key).join(value);
  }

  // Whitespace-tolerant fallbacks
  result = result.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
  result = result.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
  result = result.replace(/\{\{\s*user\.first_name\s*\}\}/gi, firstName);
  result = result.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lastName);
  result = result.replace(/\{\{\s*user\.email\s*\}\}/gi, email);
  result = result.replace(/\{\{\s*lead_type\s*\}\}/gi, leadType);
  result = result.replace(/\{\{\s*lead_address\s*\}\}/gi, address);
  result = result.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead.address_street ?? "");
  result = result.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead.address_city ?? "");
  result = result.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead.address_province ?? "");
  result = result.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, resolvedFileNumber);
  // Short-form alias fallbacks
  result = result.replace(/\{\{\s*first_name\s*\}\}/gi, firstName);
  result = result.replace(/\{\{\s*last_name\s*\}\}/gi, lastName);
  result = result.replace(/\{\{\s*full_name\s*\}\}/gi, fullName);
  result = result.replace(/\{\{\s*email\s*\}\}/gi, email);
  result = result.replace(/\{\{\s*property_address\s*\}\}/gi, address);
  result = result.replace(/\{\{\s*file_number\s*\}\}/gi, resolvedFileNumber);
  result = result.replace(/\{\{\s*side_suffix\s*\}\}/gi, sideSuffix);
  result = result.replace(/\{\{\s*property_role_row\s*\}\}/gi, propertyRoleRow);

  return result;
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
      console.log(
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
        console.log(
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
    console.log(
      `[Welcome Email] Skipped — no welcome template configured. lead=${leadId} source=${opts.source ?? "unknown"}`,
    );
    return {
      success: true,
      skipped: true,
      skipReason: "No welcome template configured",
    };
  }

  // 5. Build body
  let rawBody = template.body;

  rawBody = rawBody
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&nbsp;/g, " ")
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
  const subject = await interpolate(rawSubject, lead, fileNumber);

  // 7. Send
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)", statusCode: 500 };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  const { data: sendResult, error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: "testing@iclosed.ca",
    to: [lead.email],
    subject,
    html: htmlBody,
  });

  if (sendError) {
    console.error(`[Welcome Email] Resend error (source=${opts.source ?? "unknown"}):`, sendError);
    return { success: false, error: `Email send failed: ${sendError.message}`, statusCode: 500 };
  }

  // 8. Mark sent — guards against duplicate sends from any other trigger
  const { error: updateError } = await supabaseAdmin
    .from("leads")
    .update({ welcome_email_sent: true })
    .eq("id", leadId);

  if (updateError) {
    console.error("[Welcome Email] Failed to update welcome_email_sent:", updateError);
  }

  console.log(
    `[Welcome Email] Sent to ${lead.email} (source=${opts.source ?? "unknown"}), subject="${subject}", id=${sendResult?.id}`,
  );

  return {
    success: true,
    emailId: sendResult?.id,
    templateUsed: template?.name ?? "Default Welcome",
  };
}
