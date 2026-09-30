-- Agent-only milestone emails, and the first one: "Signing appointment booked".
--
-- Until now a milestone email could reach the referral agent in exactly one
-- way: `email_templates.shared_with_agent`, which CCs them on the CLIENT's
-- email. There was no way to tell the agent something without telling the
-- client — and "your client's signing has been booked" is a message for the
-- agent, whose client has usually just been told directly by the signing clerk.
--
-- `agent_only` inverts the recipients: the agent (plus their partner_contacts
-- and the file's cc_emails) go in `to`, and the client is on neither line. The
-- standing oversight address stays a CC. See src/lib/sendMilestoneEmail.ts.
--
-- In an agent-only body, `{{ user.* }}` is the AGENT — they are who the email
-- greets — and the client is `{{ client_name }}` / `{{ client_first_name }}`.
--
-- Run this BEFORE deploying, or template saves log a warning and silently drop
-- the flag (the route tolerates the missing column so nothing breaks either
-- way).

-- ---------------------------------------------------------------------------
-- 1. The flag
-- ---------------------------------------------------------------------------

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS agent_only boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN email_templates.agent_only IS
  'Send TO the referral agent instead of the client; the client is not emailed or CC''d. Mutually exclusive with shared_with_agent, which only CCs the agent on the client''s email.';

-- A template cannot be both: shared_with_agent CCs the agent onto the client's
-- email, which an agent-only template never sends.
UPDATE email_templates
   SET shared_with_agent = false
 WHERE agent_only = true
   AND shared_with_agent = true;

-- ---------------------------------------------------------------------------
-- 2. The template
-- ---------------------------------------------------------------------------
-- Wording lives here as a row, not in code, so it stays editable from the Email
-- Templates page without a deploy. The logo is an <img> in the body like every
-- other template's; brandEmailHtml() rewrites the filename per firm at send
-- time.

INSERT INTO email_templates (name, subject, body, is_active, shared_with_agent, agent_only)
SELECT
  'Signing appointment scheduled (agent)',
  'Signing booked — {{ client_name }}, {{ property_address }}',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ agent_first_name }},</p>

  <p>Your client <strong>{{ client_name }}</strong>, {{ property_address }}, closing {{ closing_date }} has been scheduled for a signing.</p>

  <p style="margin: 16px 0 4px 0;">Warm regards,</p>

  <img src="https://admin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />
</div>',
  true,
  false,
  true
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
   WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
     AND deleted = false
);

-- ---------------------------------------------------------------------------
-- 3. Link it to the Signing appointment stage
-- ---------------------------------------------------------------------------
-- A stage can carry ONE email template, so this only fills stages that have
-- none. Any "signing" stage that already has a client-facing email is listed by
-- the query at the bottom instead of being overwritten — swapping a client
-- email for an agent-only one is a decision, not a migration.

UPDATE stage_templates st
   SET email_template_id = (
         SELECT id FROM email_templates
          WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
            AND deleted = false
          LIMIT 1
       )
 WHERE st.email_template_id IS NULL
   AND lower(st.name) LIKE '%signing appointment%';

-- Existing files carry their own snapshot of the link (milestones.email_
-- template_id is copied at conversion), so backfill the ones still open. A
-- milestone already completed or already emailed is left alone — it is history.

UPDATE milestones m
   SET email_template_id = (
         SELECT id FROM email_templates
          WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
            AND deleted = false
          LIMIT 1
       )
 WHERE m.email_template_id IS NULL
   AND coalesce(m.email_sent, false) = false
   AND coalesce(m.status, '') <> 'Completed'
   AND lower(coalesce(m.title, '')) LIKE '%signing appointment%';

-- ---------------------------------------------------------------------------
-- 4. What to check
-- ---------------------------------------------------------------------------

-- The new template.
SELECT id, name, is_active, agent_only, shared_with_agent
FROM email_templates
WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)';

-- Signing stages that were NOT linked because they already send something else.
-- Decide per stage whether the agent email should replace it.
SELECT st.id, st.name, et.name AS current_template
FROM stage_templates st
LEFT JOIN email_templates et ON et.id = st.email_template_id
WHERE lower(st.name) LIKE '%signing appointment%'
  AND st.email_template_id IS NOT NULL
  AND lower(btrim(coalesce(et.name, ''))) <> 'signing appointment scheduled (agent)';

-- How many open milestones now point at it.
SELECT count(*) AS linked_open_milestones
FROM milestones m
JOIN email_templates et ON et.id = m.email_template_id
WHERE lower(btrim(et.name)) = 'signing appointment scheduled (agent)';
