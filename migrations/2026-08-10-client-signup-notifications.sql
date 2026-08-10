-- Adds the "client just signed up" event to the admin notification feed, and
-- refreshes the all-tasks-complete email template to mention its attachments.
--
-- DEPENDS ON 2026-07-31-all-tasks-complete-notifications.sql, which creates
-- `notifications` / `notification_reads` and `deals.all_tasks_notified_at`.
-- RUN THAT FIRST if it has not been applied to this database — the notification
-- feature has been sitting on the `dev` branch and was never deployed, so on
-- production neither migration has run yet. This file is safe either way: it
-- checks for the table and stops with a clear error rather than half-applying.
--
-- Two pieces:
--
--   1. Nothing structural. `notifications.type` is free-text by design so new
--      event kinds need no schema change — src/lib/notifyClientSignup.ts just
--      writes type = 'client.signed_up'. The index on (type) already covers it.
--      Recorded here anyway so the event key is documented alongside the other
--      migration rather than living only in code.
--
--   2. The "All Tasks Completed" email body is updated to reference the
--      attached document package (src/lib/familyDocuments.ts now attaches every
--      document the family uploaded, up to a 20MB budget; the overflow is
--      appended by the sender as download links).
--
-- Idempotent: safe to re-run.

BEGIN;

-- 0 ─── Guard: fail loudly if the base migration hasn't been applied ─────────
DO $$
BEGIN
  IF to_regclass('public.notifications') IS NULL THEN
    RAISE EXCEPTION
      'notifications table missing — apply migrations/2026-07-31-all-tasks-complete-notifications.sql first';
  END IF;
END $$;

-- 1 ─── FIX: grant service_role access to the notification tables ───────────
--
-- The 2026-07-31 migration created `notifications` / `notification_reads` but
-- never granted anything on them, so every read through supabaseAdmin failed
-- with 42501 "permission denied for table notifications" and /api/admin/
-- notifications answered 500. Supabase's default privileges cover tables
-- created by the `postgres` role in the SQL editor; these two didn't pick them
-- up, so the grant has to be explicit.
--
-- service_role ONLY, deliberately. The admin app reads this feed exclusively
-- through the service-role client (src/lib/supabaseAdmin.ts) behind the
-- /api/admin/* auth middleware. Withholding the grant from `anon` and
-- `authenticated` means a leaked public key still cannot read the feed, which
-- carries client names and property addresses.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications      TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_reads TO service_role;

-- 2 ─── Document the event keys the feed carries ─────────────────────────────
COMMENT ON COLUMN notifications.type IS
  'Stable event key. Known values: ''deal.all_tasks_complete'' (src/lib/notifyAllTasksComplete.ts — client and co-party finished every client-visible task; also emails every active admin) and ''client.signed_up'' (src/lib/notifyClientSignup.ts — client activated their portal account; in-app only, raised from /api/webhooks/activate-deal). Free-text so new event kinds need no migration.';

-- 3 ─── REPAIR: strip the document placeholders back out of the template ─────
--
-- An earlier draft of this migration put {{ attached_count }} and
-- {{ document_count }} into the template body. That was a mistake, and it shipped
-- broken emails on 2026-08-10 reading "All {{ attached_count }} of their
-- uploaded documents are attached".
--
-- WHY it broke: `email_templates` lives in the SHARED Supabase database, so a
-- template edit goes live in EVERY environment the moment it is committed —
-- local, the dev deploy, production. The code that resolves placeholders ships
-- per-deploy. So a template referencing a brand-new placeholder renders it
-- LITERALLY in every environment that hasn't deployed the matching code yet.
-- Template changes are effectively instant-deploy; code changes are not.
--
-- THE RULE: never add a new {{ placeholder }} to a seeded template in the same
-- change that adds the value behind it. Either deploy the code first and change
-- the template in a later migration, or — better, and what we do here — generate
-- the dynamic part in code and append it to the rendered body. The document
-- block is now produced by renderDocumentSummaryHtml() in
-- src/lib/familyDocuments.ts, so an undeployed environment simply omits it
-- instead of emailing raw template syntax.
--
-- This restores the body to the 2026-07-31 wording. It matches on the broken
-- text specifically, so a template an admin has since reworded by hand is left
-- alone.
--
-- Placeholders resolved by src/lib/notifyAllTasksComplete.ts (all pre-existing):
--   {{ client_name }}      primary client's full name
--   {{ co_party_names }}   co-purchasers / co-sellers, comma separated
--   {{ party_summary }}    "Jane Doe and John Doe" — client + co-party
--   {{ transaction }}      "Purchase of 12 King St, Toronto, ON" (side-aware)
--   {{ property_address }} the raw address only, no "Purchase of" prefix
--   {{ closing_date }}     "March 14, 2026" or "TBD"
--   {{ file_number }}      the family's shared file number
--   {{ lead_type }}        "Purchase" / "Sale" / "Purchase & Sale"
--   {{ task_count }}       number of client-visible tasks completed
--   {{ deal_url }}         absolute link to the deal in the admin portal
--
-- `document_count` / `attached_count` DO still resolve if someone deliberately
-- adds them to a template later — they just aren't seeded into it.
UPDATE email_templates
SET body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi team,</p>
  <p>
    Your client <strong>{{ party_summary }}</strong> with {{ transaction }}
    (closing date: <strong>{{ closing_date }}</strong>) has completed all the tasks on iClosed.
  </p>
  <p>Please log in to review.</p>
  <p style="margin-top:24px;">
    <a href="{{ deal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Review file {{ file_number }}
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">
    File {{ file_number }} &middot; {{ lead_type }} &middot; {{ task_count }} tasks completed
  </p>
</div>'
WHERE name = 'All Tasks Completed'
  AND (body LIKE '%{{ attached_count }}%' OR body LIKE '%{{ document_count }}%');

COMMIT;

-- Verification. `service_role_can_read` MUST come back true — that is the fix
-- for the 500 on /api/admin/notifications.
SELECT
  has_table_privilege('service_role', 'public.notifications', 'SELECT')          AS service_role_can_read,
  has_table_privilege('service_role', 'public.notification_reads', 'INSERT')     AS service_role_can_write_reads,
  (SELECT count(*) FROM notifications WHERE type = 'client.signed_up')          AS signup_notifications,
  (SELECT count(*) FROM notifications WHERE type = 'deal.all_tasks_complete')   AS all_tasks_notifications,
  -- MUST be 0. Any remaining placeholder here renders literally in the email.
  (SELECT count(*) FROM email_templates
     WHERE name = 'All Tasks Completed'
       AND (body LIKE '%{{ attached_count }}%'
         OR body LIKE '%{{ document_count }}%'))                                AS broken_placeholders;
