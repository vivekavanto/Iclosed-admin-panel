// Emails a client their closing-cost estimate, with the statement PDF attached.
//
// Mirrors the inline Resend pattern used by sendPartnerCodeEmail.ts /
// convertLead.ts (RESEND_API_KEY, RESEND_FROM_EMAIL fallback, replyTo).
//
// The summary in the body is deliberately short — the balance due plus the
// headline total. The full breakdown is the attached PDF, which is the
// authoritative document and the one the firm stands behind.

import { escapeHtml } from "./renderEmailTemplate";
import type { Statement } from "./closingCosts";
import type { StatementTypeConfig } from "./closingCostSettings";

export interface ClosingEstimateEmailParams {
  to: string;
  statement: Statement;
  statementType: StatementTypeConfig;
  /** The merged firm config — supplies the sender's name in the sign-off. */
  config: Record<string, unknown>;
  clientName?: string | null;
  propertyAddress?: string | null;
  fileNo?: string | null;
  /** Already formatted for display; this module never calls Date. */
  closingDate?: string | null;
  /** The statement PDF. Omitted only if generation failed. */
  pdf?: { fileName: string; bytes: Uint8Array } | null;
}

/** "$21,363.69" — matches formatCurrency's output without importing React-land. */
function money(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${abs}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: unknown): boolean {
  return typeof value === "string" && EMAIL_RE.test(value.trim());
}

export async function sendClosingEstimateEmail(
  params: ClosingEstimateEmailParams,
): Promise<{ success: boolean; error?: string }> {
  const to = (params.to ?? "").trim();
  if (!isEmailAddress(to)) {
    return { success: false, error: "Enter a valid email address." };
  }

  const { statement, statementType, config, pdf } = params;
  const firmName = String(config.firm_name ?? "").trim() || "iClosed";
  const firstName =
    (params.clientName ?? "").trim().split(/\s+/)[0] || "there";

  // Every interpolated value is escaped — a property address or a purchaser
  // name is free text a staff member typed, and this is an HTML document.
  const e = escapeHtml;
  const rows: Array<[string, string]> = [];
  if (params.propertyAddress) rows.push(["Property", params.propertyAddress]);
  if (params.closingDate) rows.push(["Closing date", params.closingDate]);
  if (params.fileNo) rows.push(["File No.", params.fileNo]);

  const detailHtml = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding: 4px 12px 4px 0; font-size: 13px; color: #64748b;">${e(label)}</td>
        <td style="padding: 4px 0; font-size: 13px; color: #1e293b;">${e(value)}</td>
      </tr>`,
    )
    .join("");

  const html = `
    <div style="font-family: Arial, Helvetica, sans-serif; color: #1e293b; max-width: 560px; margin: 0 auto;">
      <p style="font-size: 15px;">Hi ${e(firstName)},</p>
      <p style="font-size: 15px; line-height: 1.6;">
        Here is your ${e(statementType.label.toLowerCase())} of the costs to close your purchase.
        ${pdf ? "The full breakdown is attached as a PDF." : ""}
      </p>

      ${detailHtml ? `<table style="margin: 20px 0; border-collapse: collapse;">${detailHtml}</table>` : ""}

      <div style="margin: 24px 0; border: 1px solid #FECACA; background: #FEF2F2; border-radius: 10px; padding: 18px 20px;">
        <p style="margin: 0 0 6px; font-size: 12px; font-weight: bold; letter-spacing: 0.5px; color: #C10007;">
          FUNDS YOU&rsquo;LL NEED ON CLOSING
        </p>
        <p style="margin: 0; font-size: 26px; font-weight: bold; color: #C10007;">
          ${e(money(statement.balance.balanceDue))}
        </p>
        <p style="margin: 10px 0 0; font-size: 13px; color: #475569;">
          Total closing costs (fees, taxes &amp; disbursements): <strong>${e(money(statement.total))}</strong>
        </p>
      </div>

      <p style="font-size: 13px; line-height: 1.6; color: #475569;">
        ${e(statementType.disclaimer_intro)}
      </p>
      ${
        statementType.footer_note
          ? `<p style="font-size: 12px; line-height: 1.6; color: #64748b;">${e(statementType.footer_note)}</p>`
          : ""
      }

      <p style="font-size: 14px; color: #475569;">&mdash; ${e(firmName)}</p>
    </div>
  `;

  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.RESEND_FROM_EMAIL || "iClosed <support@iclosed.ca>";

  try {
    await resend.emails.send({
      from: fromEmail,
      replyTo: "testing@iclosed.ca",
      to: [to],
      subject: params.fileNo
        ? `${statementType.label} — closing costs (File ${params.fileNo})`
        : `${statementType.label} — your closing costs`,
      html,
      attachments: pdf
        ? [{ filename: pdf.fileName, content: Buffer.from(pdf.bytes) }]
        : undefined,
    });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Could not send the email",
    };
  }
}
