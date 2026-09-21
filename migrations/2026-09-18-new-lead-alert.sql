-- "A new lead just signed up" alert for the back office.
--
-- Two halves, both driven from code that already exists after this deploy:
--
--   • EMAIL — the customer portal has sent a new-lead email at intake for a
--     while (iclosed_dev_web/src/lib/sendLeadNotificationEmail.ts), rendering
--     the "Lead Notification Email" row below. Two things change: it now goes
--     to iclosed@navawilson.law and aliya@navawilson.law instead of the
--     staging inbox (that move is in code/env, not here), and the wording drops
--     the client detail table in favour of a short "go and look" notice. This
--     migration rewrites the row to match.
--
--   • IN-APP — a `lead.created` row in the existing `notifications` table,
--     written by the portal at intake (iclosed_dev_web/src/lib/notifyNewLead.ts).
--     It needs NO new table: `notifications` and `notification_reads` were
--     created by 2026-07-31-all-tasks-complete-notifications.sql and already
--     carry a nullable `lead_id`, which is what a pre-conversion lead has
--     instead of a deal. Only the index below is new, and only so the sidebar's
--     Leads badge (GET /api/admin/notifications/new-leads) can filter on type
--     and recency without scanning the whole feed.
--
-- Why the detail table went away: the alert is delivered to a shared mailbox
-- and says nothing a clerk can act on from the inbox — they have to open
-- iClosed regardless. Keeping names, phone numbers, prices and addresses out of
-- it means a new lead costs nothing if that mailbox is ever compromised. The
-- in-app row still carries the name, so nothing is lost where staff are already
-- authenticated.
--
-- The body stays a template row rather than a string in code so the wording can
-- be corrected from /admin/templates/emails without a deploy. Note the shared
-- database: the moment this runs, the portal (the only sender of this email)
-- picks up the new copy — there is no deploy to wait for.
--
-- Idempotent: safe to re-run.
--
-- ⚠ RUN THIS WITH PLAIN "Run", NOT "Run and enable RLS". The copy below
-- contains the phrase "look into iClosed", and the Supabase SQL editor's RLS
-- helper parses "INTO <word>" inside a string literal as a SELECT … INTO, then
-- fails with 42P01 'relation "iclosed" does not exist'. The statement itself is
-- fine; only that wrapper misreads it.

BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────
-- Index for the Leads badge query: newest rows of one type.
CREATE INDEX IF NOT EXISTS notifications_type_created_at_idx
  ON notifications (type, created_at DESC);

-- 2 ─────────────────────────────────────────────────────────────────────────
-- Reword the existing alert. Matched with ILIKE because the sender looks the
-- row up the same way ('%Lead Notification%'), so whichever row it would have
-- rendered is the row that gets rewritten here.
--
-- The logo is an <img> in the template body, as it is in every other row —
-- nothing in the send path injects it. It points at the admin app's own
-- public/ on main; leaving it out here would ship the one unbranded email.
UPDATE email_templates
SET
  subject = 'New lead on iClosed',
  body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p style="margin:0 0 24px;">
    <img src="https://devadmin.iclosed.ca/logo.png" alt="iClosed" height="28" style="display:block;border:0;" />
  </p>
  <p>Hi team,</p>
  <p>A new lead just signed up on iClosed.</p>
  <p>Please look into iClosed for the details.</p>
</div>'
-- Scoped the same way the sender scopes its lookup, so an archived copy of the
-- row is left as the archive it is rather than quietly given new wording.
WHERE name ILIKE '%Lead Notification%'
  AND (is_deleted IS NULL OR is_deleted = FALSE);

-- 3 ─────────────────────────────────────────────────────────────────────────
-- Seed it on a database that never had the row (a fresh environment). Without
-- this the sender falls back to its built-in copy, which works but cannot be
-- edited from the admin UI.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Lead Notification Email',
  'New lead on iClosed',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p style="margin:0 0 24px;">
    <img src="https://devadmin.iclosed.ca/logo.png" alt="iClosed" height="28" style="display:block;border:0;" />
  </p>
  <p>Hi team,</p>
  <p>A new lead just signed up on iClosed.</p>
  <p>Please look into iClosed for the details.</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Lead Notification%'
);

-- Verification
SELECT name, subject, is_active
FROM email_templates
WHERE name ILIKE '%Lead Notification%';

COMMIT;
