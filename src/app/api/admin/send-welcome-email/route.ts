import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);


const DEFAULT_WELCOME_BODY = `Hi {{ user.first_name }},

Congratulations on your {{ lead_type }} of {{ lead_address }}.
One of our team members will be reaching out to you shortly to walk you through the next steps.

In the meantime, feel free to explore the resources below to learn more about our services and how we structure our pricing:

{{RESOURCE_LINKS}}

We look forward to connecting with you soon!

Warm regards,

iClosed by Nava Wilson`;

function interpolateVariables(text: string, lead: any): string {
  const fullName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
  const address = [
    lead.address_street,
    lead.address_city,
    lead.address_province,
    lead.address_postal_code,
  ]
    .filter(Boolean)
    .join(", ");

  const variableMap: Record<string, string> = {
    "{{ user.first_name }}": lead.first_name ?? "",
    "{{ user.last_name }}": lead.last_name ?? "",
    "{{ user.get_full_name }}": fullName,
    "{{ lead_address }}": address,
    "{{ lead.address_line1 }}": lead.address_street ?? "",
    "{{ lead.address_city }}": lead.address_city ?? "",
    "{{ lead.address_province }}": lead.address_province ?? "",
    "{{ lead.file_number }}": lead.file_number ?? "",
    "{{ lead_type }}": (lead.lead_type ?? "purchase").toLowerCase(),
    "{{ stage_name }}": "",
    "{{ stage_status }}": "",
    // Without spaces
    "{{user.first_name}}": lead.first_name ?? "",
    "{{user.last_name}}": lead.last_name ?? "",
    "{{user.get_full_name}}": fullName,
    "{{lead_address}}": address,
    "{{lead.address_line1}}": lead.address_street ?? "",
    "{{lead.address_city}}": lead.address_city ?? "",
    "{{lead.address_province}}": lead.address_province ?? "",
    "{{lead.file_number}}": lead.file_number ?? "",
    "{{lead_type}}": (lead.lead_type ?? "purchase").toLowerCase(),
    // Legacy
    "{{NAME}}": fullName,
    "{{LEAD_TYPE}}": (lead.lead_type ?? "purchase").toLowerCase(),
    "{{CLIENT_ADDRESS}}": address,
  };

  let result = text;
  for (const [key, value] of Object.entries(variableMap)) {
    result = result.split(key).join(value);
  }

  // Catch any remaining {{ ... }} placeholders with flexible whitespace matching
  result = result.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim());
  result = result.replace(/\{\{\s*user\.first_name\s*\}\}/gi, lead.first_name ?? "");
  result = result.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lead.last_name ?? "");
  result = result.replace(/\{\{\s*user\.full_name\s*\}\}/gi, `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim());
  result = result.replace(/\{\{\s*user\.email\s*\}\}/gi, lead.email ?? "");
  result = result.replace(/\{\{\s*lead_type\s*\}\}/gi, (lead.lead_type ?? "purchase").toLowerCase());
  result = result.replace(/\{\{\s*lead_address\s*\}\}/gi, [lead.address_street, lead.address_city, lead.address_province, lead.address_postal_code].filter(Boolean).join(", "));
  result = result.replace(/\{\{\s*lead\.address_line1\s*\}\}/gi, lead.address_street ?? "");
  result = result.replace(/\{\{\s*lead\.address_city\s*\}\}/gi, lead.address_city ?? "");
  result = result.replace(/\{\{\s*lead\.file_number\s*\}\}/gi, lead.file_number ?? "");

  return result;
}

function buildHtmlEmail(bodyText: string): string {
  return `
    <div>
      ${bodyText}
      <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
    </div>
  `;
}

function buildSubject(_lead: any): string {
  return "Welcome to iClosed";
}

/**
 * POST /api/admin/send-welcome-email
 *
 * Body: { lead_id: string, template_id?: string, template_name?: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lead_id, template_id, template_name } = body;

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 }
      );
    }

    // 1. Fetch the lead
    const { data: lead, error: leadError } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", lead_id)
      .single();

    if (leadError || !lead) {
      return NextResponse.json(
        { success: false, error: "Lead not found" },
        { status: 404 }
      );
    }

    // 2. Fetch the email template
    let template: any = null;

    if (template_id) {
      const { data, error } = await supabaseAdmin
        .from("email_templates")
        .select("*")
        .eq("id", template_id)
        .single();
      if (!error && data) template = data;
    }

    if (!template) {
      const { data: templates, error: templateError } = await supabaseAdmin
        .from("email_templates")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (!templateError && templates && templates.length > 0) {
        const searchName = template_name || "Welcome";
        template =
          templates.find((t: any) =>
            t.name.toLowerCase().includes(searchName.toLowerCase())
          ) || templates[0];
      }
    }

    // 3. Use template body or fallback to default
    let rawBody =
      template?.body && template.body.trim() !== ""
        ? template.body
        : DEFAULT_WELCOME_BODY;

    // Decode HTML entities that may wrap placeholders (e.g. &#123;&#123; → {{)
    rawBody = rawBody
      .replace(/&#123;/g, "{")
      .replace(/&#125;/g, "}")
      .replace(/&nbsp;/g, " ")
      .replace(/\u00A0/g, " ");

    // 4. Interpolate variables
    const emailBody = interpolateVariables(rawBody, lead);

    // 5. Build styled HTML
    const htmlBody = buildHtmlEmail(emailBody);

    // 6. Build subject line (dynamic like the reference email)
    const subject = buildSubject(lead);

    // 7. Send via Resend
    const fromEmail =
      process.env.RESEND_FROM_EMAIL || "iClosed <noreply@iclosed.ca>";

    const { data: sendResult, error: sendError } = await resend.emails.send({
      from: fromEmail,
      replyTo: "iclosed@navawilson.law",
      to: [lead.email],
      subject,
      html: htmlBody,
    });

    if (sendError) {
      console.error("[Welcome Email] Resend error:", sendError);
      return NextResponse.json(
        { success: false, error: `Email send failed: ${sendError.message}` },
        { status: 500 }
      );
    }

    // Mark welcome email as sent on the lead
    const { error: updateError } = await supabaseAdmin
      .from("leads")
      .update({ welcome_email_sent: true })
      .eq("id", lead_id);

    if (updateError) {
      console.error("[Welcome Email] Failed to update welcome_email_sent:", updateError);
    }

    console.log(
      `[Welcome Email] Sent to ${lead.email}, subject: "${subject}", id: ${sendResult?.id}`
    );

    return NextResponse.json({
      success: true,
      message: `Email sent to ${lead.email}`,
      email_id: sendResult?.id,
      template_used: template?.name ?? "Default Welcome",
    });
  } catch (err: any) {
    console.error("POST /api/admin/send-welcome-email error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
