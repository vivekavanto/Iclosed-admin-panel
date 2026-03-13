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
  return result;
}

function buildHtmlEmail(bodyText: string): string {
  let text = bodyText;

  // Build resource links block
  const linksHtml = RESOURCE_LINKS.map(
    (link) =>
      `<li style="margin-bottom:8px;"><a href="${link.url}" style="color:#2563eb;text-decoration:underline;">${link.text}</a></li>`
  ).join("\n");
  const linksBlock = `<ul style="list-style:disc;padding-left:24px;margin:16px 0;">\n${linksHtml}\n</ul>`;

  // Replace {{RESOURCE_LINKS}} placeholder
  if (text.includes("{{RESOURCE_LINKS}}")) {
    text = text.replace("{{RESOURCE_LINKS}}", linksBlock);
  }

  // Replace bullet lines (•, -, *) or plain-text lines that match resource links with markers
  for (const link of RESOURCE_LINKS) {
    const escapedText = link.text.replace(/[?]/g, "\\?");
    // Match with bullet prefix
    const bulletRegex = new RegExp(`^[•\\-\\*]\\s*${escapedText}\\s*$`, "mi");
    text = text.replace(bulletRegex, `BULLET_LINK::${link.text}::${link.url}`);
    // Match plain text line (no bullet prefix)
    const plainRegex = new RegExp(`^${escapedText}\\s*$`, "mi");
    text = text.replace(plainRegex, `BULLET_LINK::${link.text}::${link.url}`);
  }

  // Convert to HTML with proper bullet list grouping
  const lines = text.split("\n");
  const htmlParts: string[] = [];
  let inBulletBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("BULLET_LINK::")) {
      const [, linkText, url] = trimmed.split("::");
      if (!inBulletBlock) {
        htmlParts.push('<ul style="list-style:disc;padding-left:24px;margin:16px 0;">');
        inBulletBlock = true;
      }
      htmlParts.push(`<li style="margin-bottom:8px;"><a href="${url}" style="color:#2563eb;text-decoration:underline;">${linkText}</a></li>`);
      continue;
    }

    if (inBulletBlock) {
      htmlParts.push("</ul>");
      inBulletBlock = false;
    }

    if (trimmed === "") {
      // Avoid consecutive <br/> tags
      const lastPart = htmlParts[htmlParts.length - 1];
      if (lastPart !== "<br/>" && lastPart !== "</ul>") {
        htmlParts.push("<br/>");
      }
    } else if (trimmed.startsWith("<ul") || trimmed.startsWith("<li") || trimmed.startsWith("</ul")) {
      htmlParts.push(trimmed);
    } else if (trimmed.startsWith("Congratulations")) {
      const parts = trimmed.split(" of ");
      if (parts.length >= 2) {
        htmlParts.push(`<p style="margin:0 0 4px 0;">${parts[0]} of <strong>${parts.slice(1).join(" of ")}</strong></p>`);
      } else {
        htmlParts.push(`<p style="margin:0 0 4px 0;">${trimmed}</p>`);
      }
    } else {
      htmlParts.push(`<p style="margin:0 0 4px 0;">${trimmed}</p>`);
    }
  }

  if (inBulletBlock) htmlParts.push("</ul>");

  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;color:#1e293b;line-height:1.8;font-size:14px;">
      ${htmlParts.join("\n")}
    </div>
  `;
}

function buildSubject(lead: any): string {
  const leadType = (lead.lead_type ?? "purchase").toLowerCase();
  const address = [
    lead.address_street,
    lead.address_city,
    lead.address_province,
    lead.address_postal_code,
  ]
    .filter(Boolean)
    .join(", ");

  if (address) {
    return `Congratulations on your ${leadType} of ${address}`;
  }
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
    const rawBody =
      template?.body && template.body.trim() !== ""
        ? template.body
        : DEFAULT_WELCOME_BODY;

    // 4. Interpolate variables
    const emailBody = interpolateVariables(rawBody, lead);

    // 5. Build styled HTML
    const htmlBody = buildHtmlEmail(emailBody);

    // 6. Build subject line (dynamic like the reference email)
    const subject = buildSubject(lead);

    // 7. Send via Resend
    const fromEmail =
      process.env.RESEND_FROM_EMAIL || "iClosed <onboarding@resend.dev>";

    const { data: sendResult, error: sendError } = await resend.emails.send({
      from: fromEmail,
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
