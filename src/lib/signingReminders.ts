// Day-before reminder email for signing appointments.
//
// Run once a day by GET /api/internal/signing-reminders (Vercel Cron). For every
// confirmed appointment that starts TOMORROW (office timezone) and has not been
// reminded yet, the client gets one email:
//   - in person → bring two pieces of ID
//   - virtual   → have two pieces of ID ready to show on camera
// Both list the accepted IDs, the same list the ID-upload task uses.
//
// Wording lives in email_templates ("Signing Appointment Reminder (In Person)" /
// "(Virtual)") so it can be edited without a deploy; the accepted-ID list is the
// one dynamic part and is generated here as {{ accepted_ids }}.
//
// Exactly-once: reminder_sent_at is claimed with a conditional UPDATE BEFORE the
// send, so two overlapping runs can't both email. A skipped or failed send
// releases the claim so the next run retries.

import supabaseAdmin from "./supabaseAdmin";
import { sendEmail } from "./email/emailTransport";
import { type TemplateValue, escapeHtml } from "./renderEmailTemplate";
import { normalizeRecipientEmail } from "./emailIdentity";
import { brandEmailHtml } from "./emailBrand";
import { maskEmail } from "./maskEmail";
import { logger } from "./logger";
import { getSettings } from "./signingConfig";
import { OFFICE_TIMEZONE, zonedTimeToUtc } from "./signingTimezone";
import {
  findActiveTemplate,
  renderTemplate,
  formatDateTime,
  buildMeetSection,
} from "./sendSigningConfirmationEmail";

// The client-facing list from the portal's ID task (AcceptableDocumentsSection in
// iclosed_dev_web/src/components/dashboard/UploadIdentificationDrawer.tsx), with
// the same wording. If that list changes, change it here too.
export const ACCEPTED_ID_TYPES = [
  "Canadian Passport",
  "Canadian Driver's License",
  "Canadian Citizenship Card",
  "Canadian Permanent Resident Card",
  "US or Canadian NEXUS Card",
  "Canadian SIN Card (plastic only)",
  "Foreign Passport",
  "Canadian Government-issued Photo ID Card",
  "Credit Card (with signature)",
  "Birth Certificate",
];

const NOT_ACCEPTED_NOTE = "Health cards and Citizenship Certificates are not acceptable.";

const APPT_TYPE_LABEL: Record<string, string> = { virtual: "Virtual", in_person: "In Person" };

function acceptedIdsHtml(): string {
  const items = ACCEPTED_ID_TYPES.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  return (
    `<ul style="margin:8px 0 8px 20px;padding:0;">${items}</ul>` +
    `<p style="margin:0 0 8px 0;font-size:13px;color:#475569;">${escapeHtml(NOT_ACCEPTED_NOTE)}</p>`
  );
}

/** [start, end) of tomorrow's calendar day in the office timezone, as UTC instants. */
export function tomorrowWindow(now: Date = new Date()): { from: Date; to: Date } {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: OFFICE_TIMEZONE }); // YYYY-MM-DD
  const [y, m, d] = ymd.split("-").map(Number);
  // Date.UTC rolls month/year over, so "day + 1 / + 2" is safe at month ends.
  const t1 = new Date(Date.UTC(y, m - 1, d + 1));
  const t2 = new Date(Date.UTC(y, m - 1, d + 2));
  return {
    from: zonedTimeToUtc(t1.getUTCFullYear(), t1.getUTCMonth() + 1, t1.getUTCDate(), 0, 0),
    to: zonedTimeToUtc(t2.getUTCFullYear(), t2.getUTCMonth() + 1, t2.getUTCDate(), 0, 0),
  };
}

export interface ReminderRunResult {
  due: number;
  sent: number;
  skipped: number;
  failed: number;
}

export async function runSigningReminders(now: Date = new Date()): Promise<ReminderRunResult> {
  const result: ReminderRunResult = { due: 0, sent: 0, skipped: 0, failed: 0 };
  const { from, to } = tomorrowWindow(now);

  const { data: appts, error } = await supabaseAdmin
    .from("signing_appointments")
    .select("*, lawyer:signing_lawyers(full_name)")
    .eq("status", "confirmed")
    .is("reminder_sent_at", null)
    .gte("start_at", from.toISOString())
    .lt("start_at", to.toISOString());

  if (error) {
    logger.error("[SigningReminders] query failed:", error.message);
    throw new Error(error.message);
  }

  const settings = await getSettings();

  for (const appt of appts ?? []) {
    result.due += 1;
    const release = () =>
      supabaseAdmin.from("signing_appointments").update({ reminder_sent_at: null }).eq("id", appt.id);

    try {
      // Claim first — only one runner gets the row back.
      const { data: claimed } = await supabaseAdmin
        .from("signing_appointments")
        .update({ reminder_sent_at: new Date().toISOString() })
        .eq("id", appt.id)
        .is("reminder_sent_at", null)
        .eq("status", "confirmed")
        .select("id");
      if (!claimed || claimed.length === 0) continue;

      const virtual = appt.appointment_type === "virtual";
      const { template, skipReason } = await findActiveTemplate(
        virtual ? "%signing appointment reminder (virtual)%" : "%signing appointment reminder (in person)%",
      );
      if (!template) {
        logger.info(`[SigningReminders] skipped ${appt.id} — ${skipReason}`);
        await release();
        result.skipped += 1;
        continue;
      }

      const { date, time } = formatDateTime(new Date(appt.start_at));
      const values: Record<string, TemplateValue> = {
        client_name: { value: appt.client_name },
        lawyer_name: { value: appt.lawyer?.full_name ?? "" },
        appointment_date: { value: date },
        appointment_time: { value: time },
        appointment_type: { value: APPT_TYPE_LABEL[appt.appointment_type] ?? "-" },
        location: { value: virtual ? "Google Meet" : settings.office_address },
        property_address: { value: appt.property_address || "-" },
        file_number: { value: appt.file_number || "-" },
        meet_link: { value: appt.google_meet_link ?? "", raw: true },
        meet_section: {
          value: buildMeetSection(appt.appointment_type, appt.google_meet_link ?? null),
          raw: true,
        },
        accepted_ids: { value: acceptedIdsHtml(), raw: true },
      };

      const { subject, body } = renderTemplate(template, values);
      const to = normalizeRecipientEmail(appt.client_email);
      const sent = await sendEmail(
        { to: [to], subject, html: brandEmailHtml(body, "navawilson") },
        { firm: "navawilson", label: "signing-reminder" },
      );

      if (!sent.ok) {
        logger.error(`[SigningReminders] send failed for ${appt.id}: ${sent.error}`);
        await release();
        result.failed += 1;
        continue;
      }
      logger.info(`[SigningReminders] sent to ${maskEmail(to)} for ${appt.id}, id=${sent.id}`);
      result.sent += 1;
    } catch (err) {
      logger.error(`[SigningReminders] unexpected error for ${appt.id}:`, err);
      await release();
      result.failed += 1;
    }
  }

  return result;
}
