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
  escapeHtml,
  type TemplateValue,
} from "./renderEmailTemplate";
import { maskEmail } from "./maskEmail";
import { logger } from "./logger";
import { normalizeRecipientEmail } from "./emailIdentity";
import { brandEmailHtml } from "./emailBrand";
import { OFFICE_TIMEZONE } from "./signingTimezone";
import type { SigningLawyer, SigningSettings } from "./signingConfig";
import type { SigningBookingInput } from "./signingEventContent";

const DEAL_TYPE_LABEL: Record<string, string> = { purchase: "Purchase", sale: "Sale", refinance: "Refinance" };
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

export function formatDateTime(startAt: Date): { date: string; time: string } {
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

/** Builds the `{{ meet_section }}` raw HTML fragment: a Meet link line for
 *  virtual appointments only, empty otherwise (the renderer has no if/else). */
export function buildMeetSection(appointmentType: "virtual" | "in_person", meetLink: string | null): string {
  if (appointmentType !== "virtual" || !meetLink) return "";
  const safeUrl = escapeHtml(meetLink);
  return `<br />Google Meet: <a href="${safeUrl}">${safeUrl}</a>`;
}

/** Finds the newest ACTIVE template matching `namePattern`. Mirrors the
 *  strict is_active handling in sendWelcomeEmail: an admin-disabled template
 *  is a real off-switch, not a fallback trigger. */
export async function findActiveTemplate(
  namePattern: string,
): Promise<{ template: any; skipReason?: string }> {
  const { data: matching } = await supabaseAdmin
    .from("email_templates")
    .select("*")
    .ilike("name", namePattern)
    .order("created_at", { ascending: false });

  const template = (matching ?? []).find((t: any) => t.is_active);
  if (!template) {
    const skipReason =
      matching && matching.length > 0
        ? `Template matching "${namePattern}" is inactive`
        : `No template configured matching "${namePattern}"`;
    return { template: null, skipReason };
  }
  return { template };
}

/** Renders a template's subject + body against the shared placeholder set. */
export function renderTemplate(
  template: any,
  values: Record<string, TemplateValue>,
): { subject: string; body: string } {
  const resolve = (name: string): TemplateValue | null => {
    const key = name.toLowerCase().replace(/^\.+/, "");
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null;
  };

  const rawBody = decodeTemplateBraces(template.body);
  const body = renderTemplateSafe(rawBody, resolve);
  const rawSubject = template.subject?.trim() || template.name;
  const subject = renderTemplateSafe(rawSubject, resolve, { escape: false });
  return { subject, body };
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

  const { date, time } = formatDateTime(startAt);
  const meetSection = buildMeetSection(booking.appointmentType, meetLink);
  const baseValues: Record<string, TemplateValue> = {
    "client_name": { value: booking.clientName },
    "client_email": { value: booking.clientEmail },
    "client_phone": { value: booking.clientPhone || "-" },
    "lawyer_name": { value: lawyer.full_name },
    "appointment_date": { value: date },
    "appointment_time": { value: time },
    "location": { value: location },
    "property_address": { value: booking.propertyAddress || "-" },
    "closing_date": { value: booking.closingDate || "-" },
    "deal_type": { value: booking.dealType ? DEAL_TYPE_LABEL[booking.dealType] : "-" },
    "appointment_type": { value: APPT_TYPE_LABEL[booking.appointmentType] },
    "file_number": { value: booking.fileNumber || "-" },
    // System-generated URLs/markup, not user input — safe to render unescaped.
    "meet_link": { value: meetLink ?? "", raw: true },
    "meet_section": { value: meetSection, raw: true },
    "manage_url": { value: manageUrl, raw: true },
  };

  // Client email — the function's returned result, same behaviour as before.
  const { template: clientTemplate, skipReason: clientSkipReason } = await findActiveTemplate(
    "%signing appointment confirmation%",
  );
  if (!clientTemplate) {
    logger.info(`[Signing Confirmation] Skipped — ${clientSkipReason}. lawyer=${lawyer.initials}`);
    return { success: true, skipped: true, skipReason: clientSkipReason };
  }

  const { subject, body } = renderTemplate(clientTemplate, baseValues);
  const clientEmail = normalizeRecipientEmail(booking.clientEmail);
  const sendResult = await sendEmail(
    {
      to: [clientEmail],
      subject,
      html: brandEmailHtml(body, "navawilson"),
    },
    { firm: "navawilson", label: "signing-confirmation" },
  );

  const result: SigningConfirmationResult = !sendResult.ok
    ? (() => {
        logger.error(`[Signing Confirmation] send failed: ${sendResult.error}`);
        return { success: false, error: `Email send failed: ${sendResult.error}` };
      })()
    : (() => {
        logger.info(
          `[Signing Confirmation] Sent to ${maskEmail(clientEmail)} for lawyer=${lawyer.initials}, id=${sendResult.id}`,
        );
        return { success: true, emailId: sendResult.id };
      })();

  // Lawyer notification — best-effort, never lets a failure here affect the
  // client result or stop the guest emails below.
  try {
    const { template: lawyerTemplate, skipReason } = await findActiveTemplate(
      "%signing appointment lawyer notification%",
    );
    if (!lawyerTemplate) {
      logger.info(`[Signing Lawyer Notification] Skipped — ${skipReason}. lawyer=${lawyer.initials}`);
    } else {
      const rendered = renderTemplate(lawyerTemplate, baseValues);
      const lawyerEmail = normalizeRecipientEmail(lawyer.email);
      const lawyerSendResult = await sendEmail(
        {
          to: [lawyerEmail],
          subject: rendered.subject,
          html: brandEmailHtml(rendered.body, "navawilson"),
        },
        { firm: "navawilson", label: "signing-lawyer-notification" },
      );
      if (!lawyerSendResult.ok) {
        logger.error(`[Signing Lawyer Notification] send failed: ${lawyerSendResult.error}`);
      } else {
        logger.info(
          `[Signing Lawyer Notification] Sent to ${maskEmail(lawyerEmail)}, id=${lawyerSendResult.id}`,
        );
      }
    }
  } catch (err) {
    logger.error("[Signing Lawyer Notification] unexpected error:", err);
  }

  // Guest confirmations — one email per guest so addresses stay private from
  // each other. De-duplicated, lowercased, and never the client or lawyer.
  try {
    const clientEmailLower = booking.clientEmail.trim().toLowerCase();
    const lawyerEmailLower = lawyer.email.trim().toLowerCase();
    const guestEmails = Array.from(
      new Set((booking.extraGuests || []).map((g) => g.trim().toLowerCase())),
    ).filter((g) => g && g !== clientEmailLower && g !== lawyerEmailLower);

    if (guestEmails.length > 0) {
      const { template: guestTemplate, skipReason } = await findActiveTemplate(
        "%signing appointment guest confirmation%",
      );
      if (!guestTemplate) {
        logger.info(`[Signing Guest Confirmation] Skipped — ${skipReason}. lawyer=${lawyer.initials}`);
      } else {
        const rendered = renderTemplate(guestTemplate, baseValues);
        const html = brandEmailHtml(rendered.body, "navawilson");
        for (const guestEmail of guestEmails) {
          try {
            const normalized = normalizeRecipientEmail(guestEmail);
            const guestSendResult = await sendEmail(
              {
                to: [normalized],
                subject: rendered.subject,
                html,
              },
              { firm: "navawilson", label: "signing-guest-confirmation" },
            );
            if (!guestSendResult.ok) {
              logger.error(`[Signing Guest Confirmation] send failed: ${guestSendResult.error}`);
            } else {
              logger.info(
                `[Signing Guest Confirmation] Sent to ${maskEmail(normalized)}, id=${guestSendResult.id}`,
              );
            }
          } catch (err) {
            logger.error("[Signing Guest Confirmation] unexpected error sending to one guest:", err);
          }
        }
      }
    }
  } catch (err) {
    logger.error("[Signing Guest Confirmation] unexpected error:", err);
  }

  return result;
}
