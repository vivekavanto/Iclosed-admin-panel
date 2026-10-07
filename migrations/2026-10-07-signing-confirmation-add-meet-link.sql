-- Signing Appointment Confirmation email (client): add the Google Meet link.
--
-- The guest and lawyer templates already end their detail block with
-- {{ meet_section }}; the client template never had it, so the client's own
-- email carried no Meet link (only "Location: Google Meet (link in invite)").
-- sendSigningConfirmationEmail.ts already passes meet_section to every
-- template, and it renders empty for in-person appointments, so no code change
-- is needed.
--
-- Only the "Property:" line is touched (a targeted replace, not a body
-- rewrite), so any hand edits made in /admin/templates/emails are preserved.
-- Idempotent: skips a template that already contains meet_section/meet_link.
-- Can also be done by hand in /admin/templates/emails: add {{ meet_section }}
-- right after {{ property_address }}.

BEGIN;

UPDATE email_templates
SET body = replace(
  body,
  'Property: {{ property_address }}',
  'Property: {{ property_address }}{{ meet_section }}'
)
WHERE name ILIKE '%signing appointment confirmation%'
  AND (is_deleted IS NULL OR is_deleted = FALSE)
  AND body NOT ILIKE '%meet_section%'
  AND body NOT ILIKE '%meet_link%';

-- Verification: has_meet must be true. If it is false, the Property line was
-- reworded by hand; add {{ meet_section }} to the template manually.
SELECT name, is_active, body ILIKE '%meet_section%' AS has_meet
FROM email_templates
WHERE name ILIKE '%signing appointment confirmation%';

COMMIT;
