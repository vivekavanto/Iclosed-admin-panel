-- Soft-delete flags on tasks and milestones. The admin "Delete" buttons on a
-- deal used to HARD DELETE the row (and cascade-wipe task_responses + APS docs
-- for tasks), which permanently destroyed customer-submitted data and was
-- irreversible. We now mark rows is_deleted=true and filter them out of every
-- customer- and admin-facing list query; the underlying task_responses and
-- lead_corporate_docs (APS) stay intact, so a delete is fully reversible with
-- `UPDATE tasks SET is_deleted=false` / `UPDATE milestones SET is_deleted=false`.
--
-- Mirrors the existing leads soft-delete pattern
-- (2026-05-19-add-is-deleted-to-leads.sql).
--
-- Idempotent: safe to re-run.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial indexes keep the active-row list queries fast on large tables —
-- most rows have is_deleted=false so the partial form stays small.
CREATE INDEX IF NOT EXISTS tasks_active_idx
  ON tasks (deal_id)
  WHERE is_deleted = FALSE;

CREATE INDEX IF NOT EXISTS milestones_active_idx
  ON milestones (deal_id)
  WHERE is_deleted = FALSE;

-- The (deal_id, task_template_id) uniqueness must now apply only to ACTIVE
-- rows. Otherwise a soft-deleted task would permanently block re-creating the
-- same template task on that deal (and the customer-portal auto-insert relies
-- on this to revive a re-added task). Replace the old full constraint/index
-- with a partial unique index scoped to non-deleted rows. The index name is
-- preserved so the POST duplicate-detection (which matches on the constraint
-- name in the Postgres error) keeps working.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_deal_task_template_unique;
DROP INDEX IF EXISTS tasks_deal_task_template_unique;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_deal_task_template_unique
  ON tasks (deal_id, task_template_id)
  WHERE is_deleted = FALSE AND task_template_id IS NOT NULL;

-- ── Whole-deal soft delete ─────────────────────────────────────────────────
-- The admin "Delete deal" button used to hard DELETE the deals row (and, via
-- FK cascade, everything hanging off it). Soft-delete it instead and filter it
-- out of the admin lists + every customer access gate. Restore with
-- `UPDATE deals SET is_deleted=false`.
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS deals_active_idx
  ON deals (created_at DESC)
  WHERE is_deleted = FALSE;

-- ── Stage (milestone) template soft delete ─────────────────────────────────
-- Deleting a stage template used to hard-cascade-wipe every deal's milestones,
-- tasks and task_responses built from it. We now soft-delete the template AND
-- soft-delete its deal-side milestones/tasks (responses are kept), so the
-- cascade is fully reversible. task_templates already has is_deleted.
ALTER TABLE stage_templates
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
