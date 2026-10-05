// Confirmation email for a booked signing appointment (Phase C — previously
// stubbed with "Confirmation/notification emails are wired in Phase C" in
// src/app/api/signing/appointments/route.ts).
//
// Mirrors sendWelcomeEmail.ts's shape: pull an active `email_templates` row,
// render it with renderTemplateSafe (single-pass, HTML-escaped placeholders),
// send via the firm-aware transport, and never throw — a confirmation email
// that fails must not fail the booking itself, since the calendar event and
// the DB row are already committed by the time this runs.
//
// Firm: signing appointments are a Nava Wilson operation (signing_settings'
// clerk_email/reception_email are both @navawilson.law), so this always sends
// as "navawilson" rather than the legacy firm-agnostic address.

import { sendEmail } from "./email/emailTransport";
import supabaseAdmin from "./supabaseAdmin";
import {
  renderTemplateSafe,
  decodeTemplateBraces,
  type TemplateValue,
} from "./renderEmailTemplate";
import { maskEmail } from "./maskEmail";
import { logger } from "./logger";
import { normalizeRecipientEmail } from "./emailIdentity";
import { brandEmailHtml } from "./emailBrand";
import { OFFICE_TIMEZONE } from "./signingTimezone";
import type { SigningLawyer, SigningSettings } from "./signingConfig";
import type { SigningBookingInput } from "./signingEventContent";

const DEAL_TYPE_LABEL: Record<string, string> = { purchase: "Purchase", sale: "Sale" };
const APPT_TYPE_LABEL: Record<string, string> = { virtual: "Virtual", in_person: "In Person" };

export interface SigningConfirmationInput {
  lawyer: SigningLawyer;
  settings: SigningSettings;
  booking: SigningBookingInput;
  startAt: Date;
  endAt: Date;
  location: string;
  meetLink: string | null;
  manageUrl: string;
}

export type SigningConfirmationResult = {
  success: boolean;
  skipped?: boolean;
  skipReason?: string;
  emailId?: string;
  error?: string;
};

function formatDateTime(startAt: Date): { date: string; time: string } {
  const date = startAt.toLocaleDateString("en-US", {
    timeZone: OFFICE_TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const time = startAt.toLocaleTimeString("en-US", {
    timeZone: OFFICE_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  return { date, time };
}

/**
 * Sends the "your signing appointment is booked" email to the client.
 * Best-effort: a missing/inactive template or a send failure is reported but
 * never thrown, matching the facade contract of sendEmail().
 */
export async function sendSigningConfirmationEmail(
  input: SigningConfirmationInput,
): Promise<SigningConfirmationResult> {
  const { lawyer, settings, booking, startAt, location, meetLink, manageUrl } = input;

  if (!process.env.RESEND_API_KEY) {
    return { success: false, error: "Email service not configured (missing RESEND_API_KEY)" };
  }

  // Pick template — same strict is_active handling as sendWelcomeEmail: an
  // admin-disabled template is a real off-switch, not a fallback trigger.
  const { data: matching } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", "%signing appointment confirmation%")
    .order("created_at", { ascending: false });

  const template = (matching ?? []).find((t: any) => t.is_active);
  if (!template) {
    const skipReason =
      matching && matching.length > 0
        ? "Signing confirmation template is inactive"
        : "No signing confirmation template configured";
    logger.info(`[Signing Confirmation] Skipped — ${skipReason}. lawyer=${lawyer.initials}`);
    return { success: true, skipped: true, skipReason };
  }

  const { date, time } = formatDateTime(startAt);
  const values: Record<string, TemplateValue> = {
    "client_name": { value: booking.clientName },
    "lawyer_name": { value: lawyer.full_name },
    "appointment_date": { value: date },
    "appointment_time": { value: time },
    "location": { value: location },
    "property_address": { value: booking.propertyAddress || "-" },
    "closing_date": { value: booking.closingDate || "-" },
    "deal_type": { value: booking.dealType ? DEAL_TYPE_LABEL[booking.dealType] : "-" },
    "appointment_type": { value: APPT_TYPE_LABEL[booking.appointmentType] },
    "file_number": { value: booking.fileNumber || "-" },
    // System-generated URLs, not user input — safe to render unescaped.
    "meet_link": { value: meetLink ?? "", raw: true },
    "manage_url": { value: manageUrl, raw: true },
  };
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  };

  const rawBody = decodeTemplateBraces(template.body);
  const emailBody = renderTemplateSafe(rawBody, resolve);
  const rawSubject = template.subject?.trim() || template.name;
  const subject = renderTemplateSafe(rawSubject, resolve, { escape: false });

  const clientEmail = normalizeRecipientEmail(booking.clientEmail);
  const sendResult = await sendEmail(
    {
      to: [clientEmail],
      subject,
      html: brandEmailHtml(emailBody, "navawilson"),
    },
    { firm: "navawilson", label: "signing-confirmation" },
  );

  if (!sendResult.ok) {
    logger.error(`[Signing Confirmation] send failed: ${sendResult.error}`);
    return { success: false, error: `Email send failed: ${sendResult.error}` };
  }

  logger.info(
    `[Signing Confirmation] Sent to ${maskEmail(clientEmail)} for lawyer=${lawyer.initials}, id=${sendResult.id}`,
  );
  return { success: true, emailId: sendResult.id };
}
