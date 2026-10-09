-- Day-before reminder email for signing appointments (client requirement V2).
--
--   1. signing_appointments.reminder_sent_at — set when the reminder is claimed,
--      so a given appointment is only ever emailed once.
--   2. Two templates, picked by appointment type:
--        "Signing Appointment Reminder (In Person)" — bring two pieces of ID
--        "Signing Appointment Reminder (Virtual)"   — show two pieces of ID
--      Both list the accepted IDs via {{ accepted_ids }}, which code fills from
--      the same list the ID-upload task uses. Wording is editable from the Email
--      Templates page.
--
-- Sent by GET /api/internal/signing-reminders (Vercel Cron, daily 13:00 UTC).
-- Needs CRON_SECRET set in Vercel env. Deploy the code first; until it is live
-- no reminder is sent, so the order does not matter for correctness.
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE signing_appointments
  ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Reminder (In Person)',
  'Reminder: your signing appointment is tomorrow',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>This is a reminder that your signing appointment with {{ lawyer_name }} is tomorrow:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    In person &middot; {{ location }}<br />
    Property: {{ property_address }}
  </p>
  <p><strong>Please bring two pieces of valid identification</strong> to your appointment. Accepted ID:</p>
  {{ accepted_ids }}
  <p>If you have any questions before then, just reply to this email.</p>
  <p style="margin:16px 0 4px 0;">Warm regards,</p>
  <img src="https://admin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
   WHERE name ILIKE '%signing appointment reminder (in person)%'
     AND (is_deleted IS NULL OR is_deleted = FALSE)
);

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Reminder (Virtual)',
  'Reminder: your virtual signing appointment is tomorrow',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>This is a reminder that your virtual signing appointment with {{ lawyer_name }} is tomorrow:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    Virtual &middot; Google Meet{{ meet_section }}<br />
    Property: {{ property_address }}
  </p>
  <p><strong>Please have two pieces of valid identification ready to show on camera</strong> during the appointment. Accepted ID:</p>
  {{ accepted_ids }}
  <p>If you have any questions before then, just reply to this email.</p>
  <p style="margin:16px 0 4px 0;">Warm regards,</p>
  <img src="https://admin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
   WHERE name ILIKE '%signing appointment reminder (virtual)%'
     AND (is_deleted IS NULL OR is_deleted = FALSE)
);

COMMIT;

-- Verification: column + 2 templates.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'signing_appointments' AND column_name = 'reminder_sent_at';
SELECT name, is_active FROM email_templates
 WHERE name ILIKE '%signing appointment reminder%';
