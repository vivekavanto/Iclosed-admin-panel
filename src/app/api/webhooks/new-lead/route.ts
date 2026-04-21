import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const RESOURCE_LINKS = [
  {
    text: "Why Do you Need Title Insurance?",
    url: "https://navawilson.law/title-insurance",
  },
  {
    text: "Understanding Real Estate Transaction Costs",
    url: "https://navawilson.law/transaction-costs",
  },
  {
    text: "What Are Disbursements?",
    url: "https://navawilson.law/disbursements",
  },
];

/**
 * POST /api/webhooks/new-lead
 *
 * Sends a welcome email after first login.
 * Called by the customer portal after a user logs in for the first time.
 * Only sends once per lead (checks welcome_email_sent flag).
 *
 * Body:
 * { email: string }   — looks up lead by email
 * or { lead_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    let lead: any = null;

    // Look up lead by email or lead_id
    if (body.email) {
      const { data, error } = await supabaseAdmin
        .from("leads")
        .select("*")
        .eq("email", body.email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error || !data) {
        return NextResponse.json(
          { success: false, error: "Lead not found for this email" },
          { status: 404 }
        );
      }
      lead = data;
    } else if (body.lead_id) {
      const { data, error } = await supabaseAdmin
        .from("leads")
        .select("*")
        .eq("id", body.lead_id)
        .single();

      if (error || !data) {
        return NextResponse.json(
          { success: false, error: "Lead not found" },
          { status: 404 }
        );
      }
      lead = data;
    } else {
      return NextResponse.json(
        { success: false, error: "email or lead_id required" },
        { status: 400 }
      );
    }

    if (!lead.email) {
      return NextResponse.json(
        { success: false, error: "Lead has no email address" },
        { status: 400 }
      );
    }

    // Check if welcome email was already sent
    if (lead.welcome_email_sent) {
      return NextResponse.json({
        success: true,
        message: "Welcome email already sent previously",
        already_sent: true,
      });
    }

    // Fetch the Welcome Email template
    const { data: templates } = await supabaseAdmin
      .from("email_templates")
      .select("*")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    let templateBody = "";
    let templateName = "Default Welcome";
    let templateSubject: string | null = null;

    if (templates && templates.length > 0) {
      const welcome = templates.find((t: any) =>
        t.name.toLowerCase().includes("welcome")
      );
      const chosen = welcome || templates[0];
      if (chosen.body && chosen.body.trim() !== "") {
        templateBody = chosen.body;
        templateName = chosen.name;
        templateSubject = chosen.subject;
      }
    }

    // Fallback default body
    if (!templateBody) {
      templateBody = `Hi {{ user.first_name }},

Congratulations on your {{ lead_type }} of {{ lead_address }}.
One of our team members will be reaching out to you shortly to walk you through the next steps.

In the meantime, feel free to explore the resources below to learn more about our services and how we structure our pricing:

{{RESOURCE_LINKS}}

We look forward to connecting with you soon!

Warm regards,

iClosed by Nava Wilson`;
    }

    // Decode HTML entities that may wrap placeholders
    templateBody = templateBody
      .replace(/&#123;/g, "{")
      .replace(/&#125;/g, "}")
      .replace(/&nbsp;/g, " ")
      .replace(/\u00A0/g, " ");

    // Interpolate variables
    const fullName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim();
    const address = [
      lead.address_street,
      lead.address_city,
      lead.address_province,
      lead.address_postal_code,
    ]
      .filter(Boolean)
      .join(", ");

    const leadType = (lead.lead_type ?? "purchase").toLowerCase();

    const variableMap: Record<string, string> = {
      "{{ user.first_name }}": lead.first_name ?? "",
      "{{ user.last_name }}": lead.last_name ?? "",
      "{{ user.get_full_name }}": fullName,
      "{{ lead_address }}": address,
      "{{ lead.address_line1 }}": lead.address_street ?? "",
      "{{ lead.address_city }}": lead.address_city ?? "",
      "{{ lead.address_province }}": lead.address_province ?? "",
      "{{ lead.file_number }}": lead.file_number ?? "",
      "{{ lead_type }}": leadType,
      "{{user.first_name}}": lead.first_name ?? "",
      "{{user.last_name}}": lead.last_name ?? "",
      "{{user.get_full_name}}": fullName,
      "{{lead_address}}": address,
      "{{lead_type}}": leadType,
      "{{NAME}}": fullName,
      "{{LEAD_TYPE}}": leadType,
      "{{CLIENT_ADDRESS}}": address,
    };

    let emailBody = templateBody;
    for (const [key, value] of Object.entries(variableMap)) {
      emailBody = emailBody.split(key).join(value);
    }

    // Catch remaining placeholders with flexible whitespace
    emailBody = emailBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
    emailBody = emailBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, lead.first_name ?? "");
    emailBody = emailBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lead.last_name ?? "");
    emailBody = emailBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
    emailBody = emailBody.replace(/\{\{\s*user\.email\s*\}\}/gi, lead.email ?? "");
    emailBody = emailBody.replace(/\{\{\s*lead_type\s*\}\}/gi, leadType);
    emailBody = emailBody.replace(/\{\{\s*lead_address\s*\}\}/gi, address);

    // Build resource links HTML
    const linksHtml = RESOURCE_LINKS.map(
      (link) =>
        `<li><a href="${link.url}">${link.text}</a></li>`
    ).join("\n");
    const linksBlock = `<ul>\n${linksHtml}\n</ul>`;

    if (emailBody.includes("{{RESOURCE_LINKS}}")) {
      emailBody = emailBody.replace("{{RESOURCE_LINKS}}", linksBlock);
    }

    const htmlBody = `
      <div>
        ${emailBody}
        <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
      </div>
    `;

    // Build subject: DB subject > template name > default, with placeholder interpolation
    let subject =
      templateSubject && templateSubject.trim() !== ""
        ? templateSubject
        : templateName !== "Default Welcome"
          ? templateName
          : "Welcome to iClosed";
    for (const [key, value] of Object.entries(variableMap)) {
      subject = subject.split(key).join(value);
    }
    subject = subject.replace(/\{\{\s*user\.first_name\s*\}\}/gi, lead.first_name ?? "");
    subject = subject.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lead.last_name ?? "");
    subject = subject.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
    subject = subject.replace(/\{\{\s*lead_type\s*\}\}/gi, leadType);
    subject = subject.replace(/\{\{\s*lead_address\s*\}\}/gi, address);

    // Send via Resend
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
      console.error("[Webhook Welcome Email] Resend error:", sendError);
      return NextResponse.json(
        { success: false, error: `Email send failed: ${sendError.message}` },
        { status: 500 }
      );
    }

    // Mark welcome email as sent so it doesn't send again
    await supabaseAdmin
      .from("leads")
      .update({ welcome_email_sent: true })
      .eq("id", lead.id);

    console.log(
      `[Webhook] Welcome email sent to ${lead.email} on first login, id: ${sendResult?.id}`
    );

    return NextResponse.json({
      success: true,
      message: `Welcome email sent to ${lead.email}`,
      email_id: sendResult?.id,
      template_used: templateName,
    });
  } catch (err: any) {
    console.error("POST /api/webhooks/new-lead error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}
