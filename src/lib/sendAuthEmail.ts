import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";

/** Map action type → exact template name in email_templates table */
const TEMPLATE_NAMES: Record<"invite" | "recovery", string> = {
  invite: "Invite User",
  recovery: "Reset Password",
};

/**
 * Generates a Supabase auth link (invite or recovery) without sending the
 * default Supabase email, then delivers the email through Resend instead.
 *
 * Email content is fetched from the `email_templates` table by exact name.
 * If no matching active template exists, falls back to a built-in default.
 *
 * Templates can use all standard placeholders plus `{{ confirmation_url }}`
 * which resolves to the Supabase action link (magic link with token).
 */
export async function sendAuthEmailViaResend(opts: {
  type: "invite" | "recovery";
  email: string;
  redirectTo: string;
  userData?: Record<string, string>;
}): Promise<{
  success: boolean;
  userId?: string;
  error?: string;
}> {
  const { type, email, redirectTo, userData } = opts;

  // 1. Generate the auth link (token) without sending an email
  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type,
      email,
      options: {
        redirectTo,
        ...(userData && type === "invite" ? { data: userData } : {}),
      },
    });

  if (linkError) {
    return { success: false, error: linkError.message };
  }

  const actionLink = linkData?.properties?.action_link;
  const user = linkData?.user;

  if (!actionLink) {
    return { success: false, error: "Failed to generate auth action link" };
  }

  // 2. Derive user info for placeholders
  const firstName = user?.user_metadata?.first_name || userData?.first_name || "";
  const lastName = user?.user_metadata?.last_name || userData?.last_name || "";
  const fullName = `${firstName} ${lastName}`.trim();
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";

  // 3. Fetch email template from DB by exact name
  let subject: string;
  let bodyHtml: string;

  const templateName = TEMPLATE_NAMES[type];
  let template: { name: string; subject: string | null; body: string } | null = null;

  try {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("name, subject, body")
      .eq("name", templateName)
      .eq("is_active", true)
      .maybeSingle();

    template = data ?? null;
  } catch {
    // Non-blocking — will fall through to default
  }

  if (template?.body) {
    // ── Render DB template with placeholders ──────────────────────────────
    const placeholders: Record<string, string> = {
      // iClosed-style placeholders
      "{{ user.first_name }}": firstName,
      "{{ user.last_name }}": lastName,
      "{{ user.full_name }}": fullName,
      "{{ user.email }}": email,
      "{{ confirmation_url }}": actionLink,
      "{{user.first_name}}": firstName,
      "{{user.last_name}}": lastName,
      "{{user.full_name}}": fullName,
      "{{user.email}}": email,
      "{{confirmation_url}}": actionLink,
      // Supabase-style placeholders
      "{{ .ConfirmationURL }}": actionLink,
      "{{.ConfirmationURL}}": actionLink,
      "{{ .UserMetadata.first_name }}": firstName,
      "{{.UserMetadata.first_name}}": firstName,
      "{{ .UserMetadata.last_name }}": lastName,
      "{{.UserMetadata.last_name}}": lastName,
      "{{ .UserMetadata.email }}": email,
      "{{.UserMetadata.email}}": email,
    };

    let processedBody = template.body
      .replace(/&#123;/g, "{")
      .replace(/&#125;/g, "}")
      .replace(/&nbsp;/g, " ")
      .replace(/\u00A0/g, " ");

    for (const [key, value] of Object.entries(placeholders)) {
      processedBody = processedBody.replaceAll(key, value);
    }

    // Regex fallback for flexible whitespace (iClosed-style)
    processedBody = processedBody.replace(/\{\{\s*user\.first_name\s*\}\}/gi, firstName);
    processedBody = processedBody.replace(/\{\{\s*user\.last_name\s*\}\}/gi, lastName);
    processedBody = processedBody.replace(/\{\{\s*user\.full_name\s*\}\}/gi, fullName);
    processedBody = processedBody.replace(/\{\{\s*user\.get_full_name\s*\}\}/gi, fullName);
    processedBody = processedBody.replace(/\{\{\s*user\.email\s*\}\}/gi, email);
    processedBody = processedBody.replace(/\{\{\s*confirmation_url\s*\}\}/gi, actionLink);
    // Regex fallback for flexible whitespace (Supabase-style)
    processedBody = processedBody.replace(/\{\{\s*\.ConfirmationURL\s*\}\}/g, actionLink);
    processedBody = processedBody.replace(/\{\{\s*\.UserMetadata\.first_name\s*\}\}/g, firstName);
    processedBody = processedBody.replace(/\{\{\s*\.UserMetadata\.last_name\s*\}\}/g, lastName);
    processedBody = processedBody.replace(/\{\{\s*\.UserMetadata\.email\s*\}\}/g, email);

    subject = template.subject || template.name;
    bodyHtml = `
      <div>
        ${processedBody}
        <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
      </div>
    `;
  } else {
    // ── Fallback: built-in default (no template in DB yet) ────────────────
    if (type === "invite") {
      subject = "Activate your iClosed account";
      bodyHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827; line-height: 1.6;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700;">${greeting}</h2>
          <p style="margin: 0 0 24px 0; font-size: 15px;">
            You've been invited to access your secure iClosed customer portal. Click the button below to accept your invitation and set your password. <strong>Link expires in 24 hours.</strong>
          </p>
          <p style="margin: 24px 0;">
            <a href="${actionLink}" style="background-color: #DC2626; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; font-size: 15px;">Activate my account</a>
          </p>
          <p style="margin: 32px 0 0 0; font-size: 12px; color: #6b7280;">
            If you didn't request this invitation, you can safely ignore this email. No account will be created without your action. If the button doesn't work, <a href="${actionLink}" style="color: #DC2626;">use this link</a> instead.
          </p>
          <br/>
          <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
        </div>
      `;
    } else {
      subject = "Reset Your Password — iClosed";
      bodyHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <p>${greeting}</p>
          <p>We received a request to reset your password for your <strong>iClosed</strong> account.</p>
          <p>Click the button below to set a new password:</p>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${actionLink}" style="background-color: #1a1a2e; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>
          </p>
          <p style="font-size: 13px; color: #666;">If the button above doesn't work, <a href="${actionLink}" style="color: #1a1a2e;">use this link</a> instead.</p>
          <p style="font-size: 13px; color: #666;">If you did not request a password reset, you can safely ignore this email.</p>
          <br/>
          <img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
        </div>
      `;
    }
  }

  // 4. Send via Resend
  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)" };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <noreply@iclosed.ca>";

  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: "iclosed@navawilson.law",
    to: [email],
    subject,
    html: bodyHtml,
  });

  if (sendError) {
    return { success: false, error: `Resend send failed: ${sendError.message}` };
  }

  return { success: true, userId: user?.id };
}
