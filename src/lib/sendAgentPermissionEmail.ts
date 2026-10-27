import { sendEmail } from "./email/emailTransport";
import { brandBaseUrl, brandEmailHtml } from "./emailBrand";
import { escapeHtml } from "./renderEmailTemplate";
import { getFirm, type FirmKey } from "./firms";
import { PERMISSION_REQUEST_TTL_DAYS } from "./agentTaskPermission";

/** The public page the email's button opens. Outside /api/admin, so unauthenticated. */
export const AGENT_PERMISSION_PATH = "/api/agent-permission";

// Wording is in code, not an email_templates row: the Accept link must always be present.
export async function sendAgentPermissionEmail(opts: {
  to: string;
  firm: FirmKey;
  clientFirstName: string | null;
  agentName: string;
  brokerage: string | null;
  property: string | null;
  token: string;
}) {
  const url = `${brandBaseUrl()}${AGENT_PERMISSION_PATH}?token=${encodeURIComponent(opts.token)}`;
  const firm = getFirm(opts.firm);
  const agent = `<strong>${escapeHtml(opts.agentName)}</strong>` + (opts.brokerage ? ` of ${escapeHtml(opts.brokerage)}` : "");
  const file = opts.property ? `your file for <strong>${escapeHtml(opts.property)}</strong>` : "your file";
  const p = (html: string, style = "") => `<p style="margin:0 0 16px;${style}">${html}</p>`;
  const html =
    `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;max-width:560px;">` +
    p("{{ firm_logo }}", "margin-bottom:24px;") +
    p(`Hi ${escapeHtml(opts.clientFirstName?.trim() || "there")},`) +
    p(`Your real estate agent, ${agent}, has asked to help complete the tasks on ${file} with ${escapeHtml(firm.label)}.`) +
    p(`If you accept, your agent can fill in your task forms and upload documents for you. Everything they enter appears on your dashboard, and you can ask us to remove their access at any time.`) +
    `<p style="margin:24px 0;"><a href="${url}&amp;decision=accept" style="background:#C10007;color:#ffffff;text-decoration:none;` +
    `padding:12px 24px;border-radius:8px;display:inline-block;font-weight:600;">Accept</a></p>` +
    p(
      `Not expecting this? <a href="${url}&amp;decision=decline" style="color:#C10007;">Decline</a>, or simply ignore this email and nothing will change. ` +
        `This link expires in ${PERMISSION_REQUEST_TTL_DAYS} days.`,
      "color:#64748b;font-size:13px;",
    ) +
    p(`${escapeHtml(firm.label)}`, "color:#64748b;font-size:13px;") +
    `</div>`;

  return sendEmail(
    {
      to: [opts.to],
      subject: `${opts.agentName} is asking to help with your file`,
      html: brandEmailHtml(html, opts.firm),
    },
    { firm: opts.firm, label: "agent-permission-request" },
  );
}
