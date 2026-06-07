-- "Hide from client" flag for tasks. Lets the back-office keep a task in the
-- workflow (visible in the admin panel, still tracked per deal) while keeping
-- it OFF the customer portal / user dashboard. Distinct from is_deleted, which
-- removes the row everywhere and stops new deals from generating it.
--
-- Two layers, mirroring is_default / is_shared:
--   * task_templates.hidden_from_client — the blueprint flag. New deals copy
--     this onto their generated tasks (see convertLead.ts).
--   * tasks.hidden_from_client          — the per-deal flag the customer
--     portal must filter on (WHERE hidden_from_client = false).
--
-- The admin queries intentionally do NOT filter on this column, so the task
-- stays fully visible/editable in the back-office.
--
-- Idempotent: safe to re-run.

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS hidden_from_client BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS hidden_from_client BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: hide "Schedule an Appointment" from every user dashboard, both at
-- the template level (so future deals inherit it) and on every task row that
-- already exists across all deals.
UPDATE task_templates
  SET hidden_from_client = TRUE
  WHERE name ILIKE 'Schedule an Appointment';

UPDATE tasks
  SET hidden_from_client = TRUE
  WHERE title ILIKE 'Schedule an Appointment';
