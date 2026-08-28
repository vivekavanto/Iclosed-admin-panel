-- Move the deposit task onto the "Closing Funds Confirmed" milestone
-- ---------------------------------------------------------------------------
-- 2026-08-26-deposit-funds-task.sql hung "Deposit Funds Into Our Trust Account"
-- off whatever stage the Home Insurance Policy task used, as a fallback so the
-- new task would not float with a NULL milestone_id. That was never where it
-- belongs, and it has two live consequences on a Purchase file:
--
--   1. Completing the deposit task rolls up into the HOME INSURANCE milestone.
--      The funds milestone it should complete has no tasks at all, so it never
--      completes on its own (recalcMilestones skips a stage with zero tasks).
--   2. Once an admin ACTIVATES the deposit task - days before closing - Home
--      Insurance Policy is dragged back to Pending by a task that has nothing
--      to do with insurance, and its completion email is re-armed.
--
-- Both are fixed by pointing the template at the Purchase "Closing Funds
-- Confirmed" stage, which is the milestone that already means "the client's
-- money is in". Nothing else is needed for the auto-complete: milestone status
-- is DERIVED from the stage's tasks (src/lib/recalcMilestones.ts), so once the
-- deposit task is the only task in that stage, completing it completes the
-- milestone. There is no code change in this commit for that reason.
--
-- That stage has an email_template_id, so its completion email will now
-- actually fire - deliberately kept. It could not fire before, because a stage
-- with no tasks never transitions.
--
-- NO status recalculation is done here - milestone status is derived, so the
-- next recalc for a family corrects it. For the overwhelming majority of files
-- that recalc is a no-op: the deposit task is activation_required and still
-- INACTIVE, and recalcMilestones excludes inactive tasks, so both the old and
-- the new stage compute the same status as before.
--
-- It is NOT a no-op on a file where an admin has already activated the task.
-- At the time of writing that is 3 of 114 files on dev, and one of them
-- (26P-2138) has the deposit task already COMPLETED. On that file the next
-- recalc will flip Closing Funds Confirmed from Pending to Completed and - as
-- chosen when this change was specified - FIRE ITS COMPLETION EMAIL to the
-- client, since the stage has an email_template_id and email_sent is false.
-- That is the intended new behaviour arriving slightly early on one file, not
-- a bug, but check the file list in section 4c before running this against
-- production so nobody is surprised by the send.
--
-- This mirrors what repointTasksForTemplate() in
-- src/lib/reconcileDealMilestoneLinks.ts does when an admin changes a task
-- template's Stage in the UI: repoint the template, create the milestone on any
-- deal that lacks it (but NOT on a deal where it was soft-deleted - that was a
-- deliberate removal), then repoint the existing task rows.
--
-- Apply in the Supabase SQL editor. Idempotent: safe to re-run. Plain ASCII,
-- no BEGIN/COMMIT wrapper, matching the 2026-08-26 batch.
--
-- !! WHEN THE SUPABASE EDITOR ASKS ABOUT ROW LEVEL SECURITY, CHOOSE
-- !! "Run without RLS".
--
-- The editor's linter reads "Into Our" inside the task name as SELECT ... INTO
-- and reports a new table called "Our". Nothing here creates a table. Choosing
-- "Run and enable RLS" fails the run with
-- ERROR: 42P01: relation "Our" does not exist.


-- ---------------------------------------------------------------------------
-- 1. Point the template at the funds stage
-- ---------------------------------------------------------------------------
-- Resolved by name + lead_type rather than by a hardcoded uuid: stage_templates
-- ids differ between the dev and production databases, so a literal id would
-- silently match nothing on the other one.

UPDATE task_templates tt
   SET stage_template_id = st.id
  FROM stage_templates st
 WHERE st.lead_type = 'Purchase'
   AND st.is_deleted = false
   AND lower(trim(st.name)) = 'closing funds confirmed'
   AND tt.is_deleted = false
   AND lower(trim(tt.name)) = 'deposit funds into our trust account'
   AND tt.stage_template_id IS DISTINCT FROM st.id;


-- ---------------------------------------------------------------------------
-- 2. Create the milestone on deals that carry the task but lack the stage
-- ---------------------------------------------------------------------------
-- A deal whose row was SOFT-DELETED is skipped: someone removed that milestone
-- from that file on purpose, and re-adding it here would undo their edit. Same
-- rule the helper applies.

INSERT INTO milestones (
  deal_id, title, status, completed_at, order_index,
  email_template_id, stage_template_id, description
)
SELECT DISTINCT
  t.deal_id,
  st.name,
  CASE WHEN st.auto_complete THEN 'Completed' ELSE 'Pending' END,
  CASE WHEN st.auto_complete THEN now() ELSE NULL END,
  st.order_index,
  st.email_template_id,
  st.id,
  st.description
FROM tasks t
JOIN task_templates tt ON tt.id = t.task_template_id
CROSS JOIN LATERAL (
  SELECT s.* FROM stage_templates s
   WHERE s.lead_type = 'Purchase'
     AND s.is_deleted = false
     AND lower(trim(s.name)) = 'closing funds confirmed'
   LIMIT 1
) st
WHERE t.is_deleted = false
  AND tt.is_deleted = false
  AND lower(trim(tt.name)) = 'deposit funds into our trust account'
  AND NOT EXISTS (
    SELECT 1 FROM milestones m
     WHERE m.deal_id = t.deal_id
       AND m.stage_template_id = st.id
  );


-- ---------------------------------------------------------------------------
-- 3. Repoint the existing task rows
-- ---------------------------------------------------------------------------
-- Only where the deal has a LIVE milestone for the stage. A deal whose row is
-- soft-deleted keeps its current link rather than being unlinked.

UPDATE tasks t
   SET milestone_id = m.id
  FROM task_templates tt, milestones m, stage_templates st
 WHERE tt.id = t.task_template_id
   AND tt.is_deleted = false
   AND lower(trim(tt.name)) = 'deposit funds into our trust account'
   AND t.is_deleted = false
   AND st.lead_type = 'Purchase'
   AND st.is_deleted = false
   AND lower(trim(st.name)) = 'closing funds confirmed'
   AND m.deal_id = t.deal_id
   AND m.stage_template_id = st.id
   AND m.is_deleted = false
   AND t.milestone_id IS DISTINCT FROM m.id;


-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
-- 4a. The template should now read "Closing Funds Confirmed", not
--     "Home Insurance Policy".

SELECT tt.name AS task_template, st.name AS stage, st.lead_type
  FROM task_templates tt
  LEFT JOIN stage_templates st ON st.id = tt.stage_template_id
 WHERE tt.is_deleted = false
   AND lower(trim(tt.name)) = 'deposit funds into our trust account';

-- 4b. Every live deposit task should be linked, and every linked milestone
--     should be titled "Closing Funds Confirmed". Expect wrong_stage = 0 and
--     unlinked = 0.

SELECT count(*)                                            AS deposit_tasks,
       count(*) FILTER (WHERE t.milestone_id IS NULL)      AS unlinked,
       count(*) FILTER (
         WHERE m.stage_template_id IS DISTINCT FROM tt.stage_template_id
       )                                                   AS wrong_stage
  FROM tasks t
  JOIN task_templates tt ON tt.id = t.task_template_id
  LEFT JOIN milestones m ON m.id = t.milestone_id
 WHERE t.is_deleted = false
   AND tt.is_deleted = false
   AND lower(trim(tt.name)) = 'deposit funds into our trust account';


-- 4c. Files where the task is ALREADY ACTIVE. These are the only ones whose
--     milestone status can move as a result of this migration. Any row here
--     with deposit_task = 'Completed' will send that client the Closing Funds
--     Confirmed email on the next recalc. Run this BEFORE section 1 to see the
--     list in advance; it is read-only and safe to run at any time.

SELECT d.file_number,
       t.status      AS deposit_task,
       t.activated_at,
       m.status      AS closing_funds_milestone,
       m.email_sent
  FROM tasks t
  JOIN task_templates tt ON tt.id = t.task_template_id
  JOIN deals d ON d.id = t.deal_id
  LEFT JOIN milestones m
         ON m.deal_id = t.deal_id
        AND m.is_deleted = false
        AND m.stage_template_id = (
              SELECT s.id FROM stage_templates s
               WHERE s.lead_type = 'Purchase'
                 AND s.is_deleted = false
                 AND lower(trim(s.name)) = 'closing funds confirmed'
               LIMIT 1)
 WHERE t.is_deleted = false
   AND tt.is_deleted = false
   AND lower(trim(tt.name)) = 'deposit funds into our trust account'
   AND t.activated_at IS NOT NULL
 ORDER BY t.status DESC, d.file_number;
