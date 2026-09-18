-- 2026-09-18 — trim stored email addresses (fixes missing agent signup emails)
--
-- WHY
-- The customer portal's intake stored the email exactly as the client typed or
-- pasted it, while Supabase Auth trims the address it registers. A pasted
-- "someone@example.com " therefore produced a leads/clients row that no lookup
-- keyed on the login identity could match:
--
--   activateClientDeals()          clients.eq("email", …)   -> no row
--   /api/webhooks/activate-deal    leads.ilike("email", …)  -> no row
--
-- so the deal was never promoted off "Inactive", and sendAgentSignupEmail()'s
-- activation gate then held the "your client just signed up on iClosed"
-- notification back for good — returning success at every step, so nothing was
-- logged as a failure and the referring agent was simply never told.
--
-- The code now trims on write and both lookups are whitespace-tolerant. This
-- repairs the rows written before that.
--
-- WHITESPACE ONLY. Case is deliberately left alone: the local part of an
-- address is case-sensitive per RFC 5321, and lower-casing a client's stored
-- address is a change nobody asked for. The lookups compare case-insensitively.
--
-- COLLISIONS ARE SKIPPED, NOT FORCED. `clients.email` is UNIQUE, so where the
-- untrimmed row has a twin that already holds the trimmed address, trimming
-- would raise `clients_email_key` and roll the whole migration back (it did, on
-- first run). Those pairs are two client records for one person — the stray
-- space is how the duplicate came about — and deciding which row survives means
-- moving deals, leads and a portal login between them. That is a merge, not a
-- trim: this migration leaves them alone and lists them at the end instead.
--
-- Safe to re-run. Run it in the Supabase SQL editor for BOTH the dev and the
-- production project (migrations here are not auto-applied).

BEGIN;

-- 1. What is about to change — read this before committing.
SELECT 'leads' AS table_name, id, email AS current_email, btrim(email) AS trimmed
FROM leads
WHERE email IS NOT NULL AND email <> btrim(email)
UNION ALL
SELECT 'clients', id, email, btrim(email)
FROM clients
WHERE email IS NOT NULL AND email <> btrim(email);

-- 2. Trim. `btrim` covers ordinary leading/trailing whitespace; `translate`
--    first folds the invisible passengers of a copy-paste — zero-width space /
--    non-joiner / joiner, the BOM, and a non-breaking space — into ordinary
--    spaces so that btrim can then take them off the ends.
--
--    The NOT EXISTS clause is the collision guard. It skips a row whose cleaned
--    address is already held by another row — whether that other row is already
--    clean, or is a second untrimmed row that would clean to the same value.
UPDATE leads c
SET email = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
WHERE c.email IS NOT NULL
  AND c.email <> btrim(translate(c.email, E'​‌‍﻿ ', '     '))
  AND NOT EXISTS (
    SELECT 1 FROM leads o
    WHERE o.id <> c.id
      AND btrim(translate(o.email, E'​‌‍﻿ ', '     '))
        = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
  );

UPDATE clients c
SET email = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
WHERE c.email IS NOT NULL
  AND c.email <> btrim(translate(c.email, E'​‌‍﻿ ', '     '))
  AND NOT EXISTS (
    SELECT 1 FROM clients o
    WHERE o.id <> c.id
      AND btrim(translate(o.email, E'​‌‍﻿ ', '     '))
        = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
  );

-- 3. Anything still untrimmed is a collision the guard skipped, listed here with
--    the row it collides with. Expect none on a clean database.
SELECT
  'leads'  AS table_name,
  c.id     AS untrimmed_id,
  c.email  AS untrimmed_email,
  o.id     AS collides_with_id,
  o.email  AS collides_with_email
FROM leads c
JOIN leads o
  ON o.id <> c.id
 AND btrim(translate(o.email, E'​‌‍﻿ ', '     '))
   = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
WHERE c.email IS NOT NULL
  AND c.email <> btrim(translate(c.email, E'​‌‍﻿ ', '     '))
UNION ALL
SELECT 'clients', c.id, c.email, o.id, o.email
FROM clients c
JOIN clients o
  ON o.id <> c.id
 AND btrim(translate(o.email, E'​‌‍﻿ ', '     '))
   = btrim(translate(c.email, E'​‌‍﻿ ', '     '))
WHERE c.email IS NOT NULL
  AND c.email <> btrim(translate(c.email, E'​‌‍﻿ ', '     '));

COMMIT;

-- ── AFTER RUNNING THIS ───────────────────────────────────────────────────────
--
-- (a) Any row listed by step 3 is a DUPLICATE PERSON, not a formatting problem.
--     Decide which client record survives, repoint the other's deals and leads
--     at it, set the loser's `merged_into_client_id` (the portal's
--     followMergedClient() already follows that pointer), and only then trim the
--     survivor. Do not delete a client row that still owns deals.
--
-- (b) Trimming does NOT release the notifications that were already missed:
--     those files are still sitting on an "Inactive" deal, and the agent email
--     only fires once the deal is Active.
--
--     To find them (they have an agent, are not yet notified, never activated):
--
--       SELECT l.id, l.email, l.referral_agent_email, d.id AS deal_id, d.status
--       FROM leads l
--       JOIN deals d ON d.lead_id = l.id AND d.is_deleted = false
--       WHERE l.agent_signup_email_sent = false
--         AND (l.partner_id IS NOT NULL OR l.referral_agent_email IS NOT NULL)
--         AND d.status = 'Inactive';
--
--     For each one, confirm the client really has signed in (Supabase Auth →
--     last_sign_in_at) before flipping the deal to Active in the admin UI, then
--     use the "notify agent" action on the lead to send the catch-up email. Do
--     NOT bulk activate: a deal that is Inactive because the client never signed
--     up should stay that way, and mailing that agent would be wrong.
