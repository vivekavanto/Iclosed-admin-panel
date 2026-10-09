-- Agent "Signing appointment scheduled" email: add signing date, time and
-- whether it is in person or virtual.
--
-- Client requirement: the agent email must say WHEN and HOW the signing is.
-- The values come from code (sendMilestoneEmail + signingAppointmentFacts.ts),
-- so DEPLOY THE CODE FIRST, then run this. Run before the code ships and the
-- agent would receive raw "{{ signing_date }}" text.
--
-- Wording lives in the template row (editable from Email Templates). Only the
-- row for the agent-only template is touched, and only if it does not already
-- carry the line, so re-running is harmless.

UPDATE email_templates
   SET body = replace(
         body,
         'has been scheduled for a signing.</p>',
         'has been scheduled for a signing.</p>

  <p><strong>Signing:</strong> {{ signing_date }} at {{ signing_time }} ({{ signing_type }})</p>'
       )
 WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
   AND deleted = false
   AND body NOT LIKE '%{{ signing_date }}%';

-- Verification: should show 1 row with has_line = true.
SELECT name, body LIKE '%{{ signing_date }}%' AS has_line
  FROM email_templates
 WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
   AND deleted = false;
