// "Your signing appointment was cancelled" email, sent only when staff typed a
// reason on the admin cancel dialog. Google's own cancellation email still goes
// out (it cannot carry a note through the API), so this one is the explanation.
//
// Wording lives in email_templates ("Signing Appointment Cancellation") so it can
// be edited without a deploy; the note itself is the one dynamic part, generated
// here as {{ cancellation_note }} (escaped, line breaks kept). If the template
// row is missing, a plain built-in version is sent instead. Never throws: the
// appointment is already cancelled by the time this runs.

import { sendEmail } from "./email/emailTransport";
import { escapeHtml, type TemplateValue } from "./renderEmailTemplate";
import { normalizeRecipientEmail } from "./emailIdentity";
import { brandEmailHtml } from "./emailBrand";
import { maskEmail } from "./maskEmail";
import { logger } from "./logger";
import { findActiveTemplate, renderTemplate, formatDateTime } from "./sendSigningConfirmationEmail";

export const MAX_CANCELLATION_NOTE_LENGTH = 1000;

/** Trimmed note, capped, or null when blank. */
export function cleanCancellationNote(raw: unknown): string | null {
  const note = String(raw ?? "").trim().slice(0, MAX_CANCELLATION_NOTE_LENGTH);
  return note || null;
}

function noteHtml(note: string): string {
  return (
    `<p style="margin:16px 0;padding:12px 16px;background:#f8fafc;border-left:3px solid #cbd5e1;white-space:pre-wrap;">` +
    `${escapeHtml(note)}</p>`
  );
}

export async function sendSigningCancellationEmail(input: {
  clientName: string;
  clientEmail: string;
  lawyerName: string;
  startAt: Date;
  propertyAddress: string | null;
  note: string;
}): Promise<void> {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const { date, time } = formatDateTime(input.startAt);
    const noteBlock = noteHtml(input.note);

    const values: Record<string, TemplateValue> = {
      client_name: { value: input.clientName },
      lawyer_name: { value: input.lawyerName },
      appointment_date: { value: date },
      appointment_time: { value: time },
      property_address: { value: input.propertyAddress || "-" },
      cancellation_note: { value: noteBlock, raw: true },
    };

    const { template } = await findActiveTemplate("%signing appointment cancellation%");
    let subject: string;
    let body: string;
    if (template) {
      ({ subject, body } = renderTemplate(template, values));
    } else {
      subject = "Your signing appointment has been cancelled";
      body =
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">` +
        `<p>Hi ${escapeHtml(input.clientName)},</p>` +
        `<p>Your signing appointment with ${escapeHtml(input.lawyerName)} on ` +
        `<strong>${escapeHtml(date)} at ${escapeHtml(time)}</strong> has been cancelled.</p>` +
        `${noteBlock}` +
        `<p>You can book a new time from your iClosed dashboard, or reply to this email if you have any questions.</p>` +
        `</div>`;
    }

    const to = normalizeRecipientEmail(input.clientEmail);
    const sent = await sendEmail(
      { to: [to], subject, html: brandEmailHtml(body, "navawilson") },
      { firm: "navawilson", label: "signing-cancellation" },
    );
    if (!sent.ok) {
      logger.error(`[Signing Cancellation] send failed: ${sent.error}`);
      return;
    }
    logger.info(`[Signing Cancellation] Sent to ${maskEmail(to)}, id=${sent.id}`);
  } catch (err) {
    logger.error("[Signing Cancellation] unexpected error:", err);
  }
}
