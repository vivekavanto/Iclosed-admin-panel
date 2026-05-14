import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";

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
};

function interpolate(text: string, lead: any, fileNumber: string | null = null): string {
  const fullName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
  const address = [
    lead.address_street,
    lead.address_city,
    lead.address_province,
    lead.address_postal_code,
  ].filter(Boolean).join(", ");
  const leadType = (lead.lead_type ?? "purchase").toLowerCase();
  const resolvedFileNumber = fileNumber ?? lead.file_number ?? "";

  const map: Record<string, string> = {
    "{{ user.first_name }}": lead.first_name ?? "",
    "{{ user.last_name }}": lead.last_name ?? "",
    "{{ user.get_full_name }}": fullName,
    "{{ user.full_name }}": fullName,
    "{{ user.email }}": lead.email ?? "",
    "{{ lead_address }}": address,
    "{{ lead.address_line1 }}": lead.address_street ?? "",
    "{{ lead.address_city }}": lead.address_city ?? "",
    "{{ lead.address_province }}": lead.address_province ?? "",
    "{{ lead.file_number }}": resolvedFileNumber,
    "{{ lead_type }}": leadType,
    "{{ stage_name }}": "",
    "{{ stage_status }}": "",
    "{{user.first_name}}": lead.first_name ?? "",
    "{{user.last_name}}": lead.last_name ?? "",
    "{{user.get_full_name}}": fullName,
    "{{user.full_name}}": fullName,
    "{{user.email}}": lead.email ?? "",
    "{{lead_address}}": address,
    "{{lead.address_line1}}": lead.address_street ?? "",
    "{{lead.address_city}}": lead.address_city ?? "",
    "{{lead.address_province}}": lead.address_province ?? "",
    "{{lead.file_number}}": resolvedFileNumber,
    "{{lead_type}}": leadType,
    "{{NAME}}": fullName,
    "{{LEAD_TYPE}}": leadType,
    "{{CLIENT_ADDRESS}}": address,
  };

  let result = text;
  for (const [key, value] of Object.entries(map)) {
    result = result.split(key).join(value);
  }

  // Whitespace-tolerant fallbacks
  result = result.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
  result = result.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
  result = result.replace(/\{\{\s*user\.first_name\s*\}\}/gi, lead.first_name ?? "");
  result = result.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lead.last_name ?? "");
  result = result.replace(/\{\{\s*user\.email\s*\}\}/gi, lead.email ?? "");
  result = result.replace(/\{\{\s*lead_type\s*\}\}/gi, leadType);
  result = result.replace(/\{\{\s*lead_address\s*\}\}/gi, address);
  result = result.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead.address_street ?? "");
  result = result.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead.address_city ?? "");
  result = result.replace(/\{\{\s*lead\.address_province\s*\}\}/gi, lead.address_province ?? "");
  result = result.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, resolvedFileNumber);

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
  if (lead.welcome_email_sent) {
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

  const emailBody = interpolate(rawBody, lead, fileNumber);

  // No HTML wrapper / logo injection — the DB template owns its layout.
  // Admins can include their own logo or footer inside the template body.
  const htmlBody = emailBody;

  // 6. Subject — derived from the template only (no hardcoded fallback).
  // Template name is required, so it always has a value.
  const rawSubject =
    template.subject && template.subject.trim() !== ""
      ? template.subject
      : template.name;
  const subject = interpolate(rawSubject, lead, fileNumber);

  // 7. Send
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)", statusCode: 500 };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <noreply@iclosed.ca>";

  const { data: sendResult, error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: "iclosed@navawilson.law",
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
