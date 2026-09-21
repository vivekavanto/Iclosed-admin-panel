-- Link "Signing appointment scheduled (agent)" to the stage that actually
-- exists on this database.
--
-- Follow-up to 2026-09-18-agent-only-email-templates.sql, whose final check
-- returned linked_open_milestones = 0. That is not a failure of the flag or the
-- template — it means the stage this firm uses for the signing is NOT named
-- anything matching '%signing appointment%', so the LIKE in step 3 of that file
-- matched no stage_templates row and no milestone. Stage names are data, seeded
-- per database, so they have to be read rather than guessed.
--
-- PART A finds the real name. PART B links it. Run A, read the output, put the
-- exact name into B, run B.

-- ===========================================================================
-- PART A — what is this stage actually called?
-- ===========================================================================

-- A1. Did the template get created? Expect exactly one row, agent_only = true.
SELECT id, name, is_active, agent_only, shared_with_agent
FROM email_templates
WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
  AND deleted = false;

-- A2. Every stage template, with whatever email it sends today. The signing
-- stage is in here under some name — "Signing", "Closing & Signing",
-- "Appointment Booked", something. Widened deliberately: the point of this
-- query is that the narrow guess already failed.
SELECT st.id,
       st.name,
       st.order_index,
       et.name AS current_email_template,
       et.agent_only
FROM stage_templates st
LEFT JOIN email_templates et ON et.id = st.email_template_id
WHERE coalesce(st.is_deleted, false) = false
ORDER BY st.order_index NULLS LAST, st.name;

-- A3. The same question from the files' side: milestone titles in use, how many
-- carry each, and how many are still open. `milestones.title` is a per-deal
-- SNAPSHOT taken at conversion, so an older file can carry a title the stage
-- template no longer has — which is why both have to be looked at.
SELECT lower(btrim(m.title)) AS milestone_title,
       count(*) AS total,
       count(*) FILTER (
         WHERE coalesce(m.email_sent, false) = false
           AND coalesce(m.status, '') <> 'Completed'
       ) AS still_open,
       count(*) FILTER (WHERE m.email_template_id IS NOT NULL) AS already_linked
FROM milestones m
GROUP BY 1
ORDER BY 1;

-- ===========================================================================
-- PART B — link it
-- ===========================================================================
-- Edit the two settings at the top of the block, then run it. It reports what
-- it changed with RAISE NOTICE; nothing is silent.

DO $$
DECLARE
  -- 1. The stage, EXACTLY as A2/A3 spell it (case-insensitive, trimmed).
  --    Leave it as-is and nothing happens — the block refuses to guess.
  --
  --    "Appointment Scheduled" is this firm's signing appointment stage: A3
  --    showed 423 of them, 413 still open, none carrying an email template.
  --    The nearby "Documents Signing" / "Documents Signed" stages are the
  --    signing itself, which happens after the appointment is booked — this
  --    email announces the BOOKING, so it belongs here.
  v_stage_name   text := 'Appointment Scheduled';

  -- 2. Whether to take over a stage that already sends a client-facing email.
  --    A stage carries ONE template, so true means the client stops getting
  --    that email at this stage. Deliberately off.
  v_replace      boolean := false;

  v_template_id  uuid;
  v_stages       int := 0;
  v_milestones   int := 0;
BEGIN
  IF lower(btrim(v_stage_name)) = 'put the exact stage name here' THEN
    RAISE EXCEPTION 'Set v_stage_name to a real stage name from PART A first.';
  END IF;

  SELECT id INTO v_template_id
  FROM email_templates
  WHERE lower(btrim(name)) = 'signing appointment scheduled (agent)'
    AND deleted = false
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'The agent-only template is missing — run 2026-09-18-agent-only-email-templates.sql first.';
  END IF;

  -- The stage template: what every NEW file will inherit at conversion.
  UPDATE stage_templates
     SET email_template_id = v_template_id
   WHERE lower(btrim(name)) = lower(btrim(v_stage_name))
     AND coalesce(is_deleted, false) = false
     AND (v_replace OR email_template_id IS NULL);
  GET DIAGNOSTICS v_stages = ROW_COUNT;

  -- Existing files: their own snapshot of the link. Only milestones still open
  -- and not yet emailed — a completed or already-emailed one is history, and
  -- relinking it would either do nothing or send an email about something that
  -- happened weeks ago.
  UPDATE milestones m
     SET email_template_id = v_template_id
   WHERE lower(btrim(coalesce(m.title, ''))) = lower(btrim(v_stage_name))
     AND coalesce(m.email_sent, false) = false
     AND coalesce(m.status, '') <> 'Completed'
     AND (v_replace OR m.email_template_id IS NULL);
  GET DIAGNOSTICS v_milestones = ROW_COUNT;

  RAISE NOTICE 'Linked "%": % stage template(s), % open milestone(s)%',
    v_stage_name, v_stages, v_milestones,
    CASE WHEN v_replace THEN ' (replacing existing links)' ELSE '' END;

  IF v_stages = 0 AND v_milestones = 0 THEN
    RAISE NOTICE 'Nothing changed. Either the name does not match PART A exactly, or everything already carries a template (re-run with v_replace := true to take those over).';
  END IF;
END $$;

-- ===========================================================================
-- Verify
-- ===========================================================================

SELECT st.name AS stage, et.name AS sends, et.agent_only, et.is_active
FROM stage_templates st
JOIN email_templates et ON et.id = st.email_template_id
WHERE lower(btrim(et.name)) = 'signing appointment scheduled (agent)';

SELECT count(*) AS linked_open_milestones
FROM milestones m
JOIN email_templates et ON et.id = m.email_template_id
WHERE lower(btrim(et.name)) = 'signing appointment scheduled (agent)'
  AND coalesce(m.email_sent, false) = false
  AND coalesce(m.status, '') <> 'Completed';
