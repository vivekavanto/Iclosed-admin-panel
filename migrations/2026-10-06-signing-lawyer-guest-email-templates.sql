-- Seeds the two new signing-appointment templates used by the lawyer/guest
-- notification emails added to sendSigningConfirmationEmail.ts:
--   * "Signing Appointment Lawyer Notification" — sent to lawyer.email
--   * "Signing Appointment Guest Confirmation"  — sent individually to each
--     address in booking.extraGuests
--
-- Idempotent: UPDATE existing rows (if an admin already created one by hand),
-- then INSERT ... WHERE NOT EXISTS. Does not touch the earlier
-- 2026-10-05-signing-confirmation-email-template.sql row.

BEGIN;

UPDATE email_templates
SET
  subject = 'New signing appointment booked: {{ client_name }}',
  body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>A new signing appointment has been booked:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ client_name }}</strong><br />
    {{ client_email }} &middot; {{ client_phone }}<br />
    {{ appointment_date }} at {{ appointment_time }}<br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}<br />
    File number: {{ file_number }}{{ meet_section }}
  </p>
  <p style="margin:24px 0 0;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
</div>',
  is_active = TRUE
WHERE name ILIKE '%signing appointment lawyer notification%'
  AND (is_deleted IS NULL OR is_deleted = FALSE);

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Lawyer Notification',
  'New signing appointment booked: {{ client_name }}',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>A new signing appointment has been booked:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ client_name }}</strong><br />
    {{ client_email }} &middot; {{ client_phone }}<br />
    {{ appointment_date }} at {{ appointment_time }}<br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}<br />
    File number: {{ file_number }}{{ meet_section }}
  </p>
  <p style="margin:24px 0 0;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
  WHERE name ILIKE '%signing appointment lawyer notification%'
    AND (is_deleted IS NULL OR is_deleted = FALSE)
);

UPDATE email_templates
SET
  subject = 'Signing appointment confirmed: {{ client_name }}',
  body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>You have been added to a signing appointment for {{ client_name }} with {{ lawyer_name }}:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}{{ meet_section }}
  </p>
  <p>If you have any questions, just reply to this email.</p>
  <p style="margin:24px 0 0;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
</div>',
  is_active = TRUE
WHERE name ILIKE '%signing appointment guest confirmation%'
  AND (is_deleted IS NULL OR is_deleted = FALSE);

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Signing Appointment Guest Confirmation',
  'Signing appointment confirmed: {{ client_name }}',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>You have been added to a signing appointment for {{ client_name }} with {{ lawyer_name }}:</p>
  <p style="margin:16px 0;padding:16px;background:#f8fafc;border-radius:8px;">
    <strong>{{ appointment_date }} at {{ appointment_time }}</strong><br />
    {{ appointment_type }} &middot; {{ deal_type }}<br />
    Location: {{ location }}<br />
    Property: {{ property_address }}{{ meet_section }}
  </p>
  <p>If you have any questions, just reply to this email.</p>
  <p style="margin:24px 0 0;">
    <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" height="40" style="display:block;border:0;" />
  </p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
  WHERE name ILIKE '%signing appointment guest confirmation%'
    AND (is_deleted IS NULL OR is_deleted = FALSE)
);

-- Verification
SELECT name, subject, is_active,
  body NOT ILIKE '%manage_url%' AS no_manage_link
FROM email_templates
WHERE name ILIKE '%signing appointment lawyer notification%'
   OR name ILIKE '%signing appointment guest confirmation%';

COMMIT;
