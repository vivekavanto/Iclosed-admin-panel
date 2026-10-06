-- Signing Appointment Confirmation email:
--   * drop the "Need to make a change? Manage your appointment" line
--   * move the iClosed logo from the top of the email to below the closing
--     "If you have any questions..." line
--
-- Updates the template seeded by 2026-10-05-signing-confirmation-email-template.sql.
-- The body is the only thing that changes; {{ manage_url }} is still passed
-- by the sender but is simply no longer referenced.
--
-- Idempotent: safe to re-run. Can also be done by hand in
-- /admin/templates/emails.

BEGIN;

UPDATE email_templates
SET
  body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>Your signing appointment with {{ lawyer_name }} is confirmed:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}
  </p>
  <p>If you have any questions before then, just reply to this email.</p>
  <p style="margin:24px 0 0;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
</div>'
WHERE name ILIKE '%signing appointment confirmation%'
  AND (is_deleted IS NULL OR is_deleted = FALSE);

-- Verification
SELECT name, subject, is_active, body NOT ILIKE '%manage_url%' AS manage_link_removed
FROM email_templates
WHERE name ILIKE '%signing appointment confirmation%';

COMMIT;
