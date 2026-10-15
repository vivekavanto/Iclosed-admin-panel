-- Cancellation note for signing appointments (client requirement).
--
-- When staff cancel an appointment from the admin list they can type a reason.
-- If they do, the client gets this email with the reason in it, in addition to
-- Google's own cancellation email (which cannot carry a note through the API).
-- {{ cancellation_note }} is filled by code (escaped, line breaks kept). Wording
-- is editable from the Email Templates page; if this row is missing or inactive
-- the code falls back to a built-in version / skips accordingly.
--
-- No schema change: the note is only emailed, not stored.
--
-- Idempotent: safe to re-run.

BEGIN;

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Cancellation',
  'Your signing appointment has been cancelled',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>Your signing appointment with {{ lawyer_name }} has been cancelled:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    Property: {{ property_address }}
  </p>
  {{ cancellation_note }}
  <p>You can book a new time from your iClosed dashboard, or reply to this email if you have any questions.</p>
  <p style="margin:16px 0 4px 0;">Warm regards,</p>
  <img src="https://admin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
   WHERE name ILIKE '%signing appointment cancellation%'
     AND (is_deleted IS NULL OR is_deleted = FALSE)
);

COMMIT;

-- Verification. Must return a row.
SELECT name, is_active FROM email_templates
 WHERE name ILIKE '%signing appointment cancellation%';
