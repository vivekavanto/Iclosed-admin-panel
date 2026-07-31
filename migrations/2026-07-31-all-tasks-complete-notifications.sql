

-- "Client has completed all their tasks" alert for admin staff.
--
-- When every client-visible task across a whole co-purchaser/co-seller FAMILY
-- (the client plus their co-party) reaches Completed, the back office is told
-- once — by email to every active admin, and by an in-app notification shown in
-- the sidebar bell.
--
-- Three pieces:
--
--   1. `notifications` — a BROADCAST feed. One row per event, visible to every
--      admin. Per-admin read state lives separately in `notification_reads` so
--      adding a new admin doesn't require backfilling rows, and one admin
--      dismissing an alert doesn't hide it from the rest of the team.
--
--   2. `notification_reads` — per-admin read receipts, keyed by auth.users.id.
--
--   3. `deals.all_tasks_notified_at` — the idempotency claim, held on the
--      FAMILY'S PRIMARY deal. src/lib/notifyAllTasksComplete.ts flips it
--      NULL → now() with a conditional UPDATE, so two concurrent task
--      completions can't both send. It is reset to NULL whenever the family
--      stops being fully complete (a task reopens, a co-person is added, a new
--      task is pushed out from a template) so the alert can legitimately fire
--      again once everyone finishes. Mirrors the milestone `email_sent` flag.
--
--   4. A seeded "All Tasks Completed" row in `email_templates` so the wording
--      is editable from /admin/templates/emails like every other email.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stable event key, e.g. 'deal.all_tasks_complete'. Lets the UI pick an icon
  -- and lets future event types share this table.
  type          text NOT NULL,
  title         text NOT NULL,
  body          text,
  -- Where the bell should send the admin when the row is clicked.
  deal_id       uuid REFERENCES deals (id) ON DELETE CASCADE,
  lead_id       uuid REFERENCES leads (id) ON DELETE SET NULL,
  file_number   text,
  -- Event-specific extras (client names, closing date, address…). No secrets.
  metadata      jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_created_at_idx
  ON notifications (created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_deal_idx
  ON notifications (deal_id);
CREATE INDEX IF NOT EXISTS notifications_type_idx
  ON notifications (type);

-- 2 ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  -- auth.users.id of the admin who read it (same id as admin_users.id).
  admin_user_id   uuid NOT NULL,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, admin_user_id)
);

CREATE INDEX IF NOT EXISTS notification_reads_admin_idx
  ON notification_reads (admin_user_id);

-- 3 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS all_tasks_notified_at timestamptz;

COMMENT ON COLUMN deals.all_tasks_notified_at IS
  'Set on the FAMILY PRIMARY deal when the all-tasks-complete alert has been sent. Reset to NULL when the family is no longer fully complete so the alert can re-fire. See src/lib/notifyAllTasksComplete.ts.';

-- Backfill: pre-claim every family that is ALREADY fully complete today.
--
-- Without this, the first task edit on any historical closed-out file would
-- find "all tasks complete", win the claim, and alert the whole team about a
-- deal that finished months ago — a burst of stale noise on deploy day. Marking
-- them now starts the feature quiet; only completions that happen AFTER this
-- migration alert.
--
-- Completeness is judged per FAMILY (root lead + its co-leads), matching the
-- runtime check, so a primary whose co-purchaser is still pending is left
-- unclaimed and will alert properly when that co-purchaser finishes. Every deal
-- in a complete family is marked, not just the primary — only the primary's
-- value is ever read, and marking the rest is harmless if primary resolution
-- ever shifts.
WITH deal_root AS (
  SELECT d.id AS deal_id,
         COALESCE(l.parent_lead_id, l.id) AS root_lead_id
  FROM deals d
  JOIN leads l ON l.id = d.lead_id
  WHERE d.is_deleted = false
),
family_tasks AS (
  SELECT dr.root_lead_id,
         count(*)                                                    AS total,
         count(*) FILTER (WHERE t.status IS DISTINCT FROM 'Completed') AS pending
  FROM deal_root dr
  JOIN tasks t ON t.deal_id = dr.deal_id
  WHERE t.is_deleted = false
    AND t.hidden_from_client = false
  GROUP BY dr.root_lead_id
)
UPDATE deals d
SET all_tasks_notified_at = now()
FROM deal_root dr
JOIN family_tasks ft ON ft.root_lead_id = dr.root_lead_id
WHERE d.id = dr.deal_id
  AND d.all_tasks_notified_at IS NULL
  AND ft.total > 0
  AND ft.pending = 0;

COMMIT;

-- 4 ─────────────────────────────────────────────────────────────────────────
-- Seed the editable email body. Guarded on name so re-running never clobbers
-- wording the admins have since edited.
--
-- Placeholders resolved by src/lib/notifyAllTasksComplete.ts:
--   {{ client_name }}    primary client's full name
--   {{ co_party_names }} co-purchasers / co-sellers, comma separated ("" if none)
--   {{ party_summary }}  "Jane Doe and John Doe" — client + co-party in one string
--   {{ transaction }}    "Purchase of 12 King St, Toronto, ON" (side-aware)
--   {{ property_address }} the raw address only, no "Purchase of" prefix
--   {{ closing_date }}   "March 14, 2026" or "TBD"
--   {{ file_number }}    the family's shared file number
--   {{ lead_type }}      "Purchase" / "Sale" / "Purchase & Sale"
--   {{ task_count }}     number of client-visible tasks completed
--   {{ deal_url }}       absolute link to the deal in the admin portal

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'All Tasks Completed',
  'All tasks completed — {{ client_name }} ({{ file_number }})',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
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
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name = 'All Tasks Completed'
);

-- Verification
SELECT
  (SELECT count(*) FROM notifications)                                       AS notifications_rows,
  (SELECT count(*) FROM notification_reads)                                   AS read_receipt_rows,
  (SELECT count(*) FROM email_templates WHERE name = 'All Tasks Completed')   AS template_seeded,
  (SELECT count(*) FROM deals WHERE all_tasks_notified_at IS NOT NULL)        AS pre_claimed_deals;
