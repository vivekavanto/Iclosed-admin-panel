import { Resend } from "resend";
import supabaseAdmin from "./supabaseAdmin";
import { createRetainerSignToken, type RetainerSide } from "./retainerSignToken";
import { formatLeadTypeLabel, buildLeadAddressForEmail } from "./leadEmailAddress";

/**
 * Sends the "review and sign your retainer" email — the DocuSign-style link a
 * party clicks to sign WITHOUT an account. The link is backed by a
 * 'retainer_sign' invitation token (see retainerSignToken.ts) and points
 * directly at the customer portal retainer page, which validates the token.
 *
 * Mirrors sendAuthEmailViaResend's shape (template lookup + placeholder render
 * + Resend send) but for the retainer-link template instead of the auth one.
 */

// Template names/keywords for the "please sign" email. We deliberately exclude
// anything containing "signed" so we never collide with the post-sign
// "Retainer Agreement Signed" confirmation template.
const TEMPLATE_NAME_CANDIDATES = [
  "Sign Retainer",
  "Sign Your Retainer",
  "Retainer Signing",
  "Review and Sign Retainer",
];
const TEMPLATE_KEYWORDS = [
  "sign retainer",
  "sign your retainer",
  "retainer signing",
  "review and sign",
];

type RetainerTemplate = { name: string; subject: string | null; body: string };

async function findRetainerLinkTemplate(): Promise<RetainerTemplate | null> {
  for (const name of TEMPLATE_NAME_CANDIDATES) {
    const { data } = await supabaseAdmin
      .from("email_templates")
      .select("name, subject, body")
      .ilike("name", name)
      .eq("is_active", true)
      .maybeSingle();
    if (data?.body) return data as RetainerTemplate;
  }

  const { data: all } = await supabaseAdmin
    .from("email_templates")
    .select("name, subject, body")
    .eq("is_active", true);

  for (const t of all ?? []) {
    const n = (t.name ?? "").toLowerCase();
    if (n.includes("signed")) continue; // avoid the post-sign confirmation template
    if (TEMPLATE_KEYWORDS.some((k) => n.includes(k)) && t.body) {
      return t as RetainerTemplate;
    }
  }
  return null;
}

// Minimal built-in fallback so the flow works even before an admin creates a
// "Sign Retainer" template in the Email Templates UI.
function defaultRetainerEmail(opts: {
  firstName: string;
  leadAddress: string;
  leadType: string;
  sideSuffix: string;
  url: string;
}): { subject: string; html: string } {
  const { firstName, leadAddress, leadType, sideSuffix, url } = opts;
  const greeting = firstName ? `Hi ${firstName},` : "Hello,";
  const what = [leadType, leadAddress].filter(Boolean).join(" — ");
  const subject = `Please review and sign your retainer${sideSuffix}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1f2937;line-height:1.6">
      <p>${greeting}</p>
      <p>Your retainer agreement${what ? ` for ${what}` : ""} is ready for your review and signature.
      You can sign it securely below — no account or password required.</p>
      <p style="margin:28px 0">
        <a href="${url}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:600;display:inline-block">Sign your retainer</a>
      </p>
      <p style="font-size:13px;color:#6b7280">After signing you'll have the option to activate your account to upload documents — or do that later.</p>
      <p style="font-size:13px;color:#6b7280">This link expires in 7 days. If it does, just ask us to resend it.</p>
    </div>
  `.trim();
  return { subject, html };
}

function renderTemplate(
  template: RetainerTemplate,
  vars: {
    firstName: string;
    lastName: string;
    fullName: string;
    email: string;
    leadAddress: string;
    fileNumber: string;
    leadType: string;
    sideSuffix: string;
    url: string;
  },
): { subject: string; html: string } {
  const map: Record<string, string> = {
    first_name: vars.firstName,
    "user.first_name": vars.firstName,
    last_name: vars.lastName,
    "user.last_name": vars.lastName,
    full_name: vars.fullName,
    "user.full_name": vars.fullName,
    "user.get_full_name": vars.fullName,
    email: vars.email,
    "user.email": vars.email,
    lead_address: vars.leadAddress,
    property_address: vars.leadAddress,
    file_number: vars.fileNumber,
    "lead.file_number": vars.fileNumber,
    lead_type: vars.leadType,
    side_suffix: vars.sideSuffix,
    // The signing link, under every alias an admin might reasonably type.
    retainer_url: vars.url,
    retainer_link: vars.url,
    sign_url: vars.url,
    sign_link: vars.url,
    confirmation_url: vars.url,
    confirmation_link: vars.url,
    action_url: vars.url,
    action_link: vars.url,
    button_url: vars.url,
  };

  const apply = (input: string): string => {
    let out = input.replace(/&#123;/g, "{").replace(/&#125;/g, "}");
    for (const [key, value] of Object.entries(map)) {
      // Whitespace-tolerant: {{ key }} / {{key}}, optional leading dot.
      const re = new RegExp(
        `\\{\\{\\s*\\.?\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`,
        "gi",
      );
      out = out.replace(re, value);
    }
    return out;
  };

  const html = apply(template.body);
  const subject = apply(template.subject || template.name);

  if (/\{\{[^}]*(url|link)[^}]*\}\}/i.test(html)) {
    console.warn(
      `[RetainerLink] Unreplaced link placeholder in template "${template.name}" — falling back to alias map may have missed it.`,
    );
  }
  return { subject, html };
}

export async function sendRetainerLinkEmail(opts: {
  email: string;
  leadId: string;
  side: RetainerSide;
  primaryLeadId: string;
}): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
  const { email, leadId, side, primaryLeadId } = opts;

  if (!email) return { success: false, error: "no email" };

  // 1. Mint the signing link.
  let url: string;
  try {
    const issued = await createRetainerSignToken({
      email,
      leadId,
      side,
      primaryLeadId,
    });
    url = issued.url;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to mint retainer token: ${message}` };
  }

  // 2. Gather placeholder context.
  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  const firstName = lead?.first_name ?? "";
  const lastName = lead?.last_name ?? "";
  const fullName = `${firstName} ${lastName}`.trim();
  const leadAddress = await buildLeadAddressForEmail(lead);
  const leadType = formatLeadTypeLabel(lead?.lead_type);
  const sideSuffix =
    side === "purchase" ? " (Purchase)" : side === "sale" ? " (Sale)" : "";

  let fileNumber = "";
  try {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("file_number")
      .eq("lead_id", leadId)
      .maybeSingle();
    fileNumber = deal?.file_number ?? "";
  } catch {
    // non-blocking
  }

  // 3. Resolve subject + body (DB template preferred, built-in fallback).
  const template = await findRetainerLinkTemplate();
  const { subject, html } = template
    ? renderTemplate(template, {
        firstName,
        lastName,
        fullName,
        email,
        leadAddress,
        fileNumber,
        leadType,
        sideSuffix,
        url,
      })
    : defaultRetainerEmail({ firstName, leadAddress, leadType, sideSuffix, url });

  // 4. Send via Resend.
  if (!process.env.RESEND_API_KEY) {
    return {
      success: false,
      error: "Email service not configured (missing RESEND_API_KEY)",
    };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    replyTo: "testing@iclosed.ca",
    to: [email],
    subject,
    html,
  });

  if (sendError) {
    return { success: false, error: `Resend send failed: ${sendError.message}` };
  }

  return { success: true };
}

/**
 * Which retainer link(s) a party gets. The customer portal collects ONE
 * combined retainer per lead (side=null) — even for a Purchase & Sale primary,
 * whose single retainer lists both properties — and derives the purchase/sale
 * display from the lead's own lead_type + co_person_role. So every lead gets
 * exactly ONE link, regardless of type. (Kept as an array so callers can keep
 * looping uniformly if the model ever changes again.)
 */
export function retainerSidesForLeadType(
  _leadType: string | null | undefined,
): RetainerSide[] {
  return [null];
}
