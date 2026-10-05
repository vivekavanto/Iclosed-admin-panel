-- Seeds the "Signing Appointment Confirmation" email template, sent by
-- sendSigningConfirmationEmail.ts (src/lib/sendSigningConfirmationEmail.ts)
-- right after a client books a slot at /signing/[lawyerInitials]
-- (POST /api/signing/appointments). Previously that route had no email step
-- at all ("Confirmation/notification emails are wired in Phase C").
--
-- Follows the house convention (see 2026-09-18-new-lead-alert.sql): the body
-- lives in email_templates, not hardcoded in the sender, so wording can be
-- edited from /admin/templates/emails without a deploy. Matched by name ILIKE
-- the same way the sender looks it up.
--
-- Idempotent: safe to re-run.

BEGIN;

UPDATE email_templates
SET
  subject = 'Your signing appointment is confirmed',
  body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p style="margin:0 0 24px;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
  <p>Hi {{ client_name }},</p>
  <p>Your signing appointment with {{ lawyer_name }} is confirmed:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}
  </p>
  <p>Need to make a change? <a href="{{ manage_url }}">Manage your appointment</a>.</p>
  <p>If you have any questions before then, just reply to this email.</p>
</div>'
WHERE name ILIKE '%signing appointment confirmation%'
  AND (is_deleted IS NULL OR is_deleted = FALSE);

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Confirmation',
  'Your signing appointment is confirmed',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p style="margin:0 0 24px;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
  <p>Hi {{ client_name }},</p>
  <p>Your signing appointment with {{ lawyer_name }} is confirmed:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}
  </p>
  <p>Need to make a change? <a href="{{ manage_url }}">Manage your appointment</a>.</p>
  <p>If you have any questions before then, just reply to this email.</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%signing appointment confirmation%'
);

-- Verification
SELECT name, subject, is_active
FROM email_templates
WHERE name ILIKE '%signing appointment confirmation%';

COMMIT;
