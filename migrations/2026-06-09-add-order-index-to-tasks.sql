-- Per-deal task ordering.
--
-- Until now the `tasks` table had no ordering column: deal-side task lists were
-- sorted by created_at only, so reordering a task TEMPLATE in the admin panel
-- never reached existing deals or the customer portal. Milestones already carry
-- their own milestones.order_index (copied from stage_templates at conversion,
-- see convertLead.ts), and this brings tasks to parity.
--
-- After this migration:
--   • convertLead writes tasks.order_index from task_templates.order_index for
--     new deals,
--   • the admin tasks GET route sorts by order_index (created_at tiebreaker),
--   • the task-templates reorder PATCH backfills order_index onto every existing
--     deal's tasks.
--
-- Idempotent: safe to re-run.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS order_index INTEGER;

-- Backfill existing deal tasks from the order their template currently carries,
-- so already-active deals immediately reflect the admin ordering. Only fills
-- rows still missing a value — never clobbers an explicit order already set.
UPDATE tasks t
SET order_index = tt.order_index
FROM task_templates tt
WHERE t.task_template_id = tt.id
  AND t.order_index IS NULL;
