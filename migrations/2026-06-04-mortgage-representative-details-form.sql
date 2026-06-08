-- Align the mortgage task with the new "Mortgage Representative Details" spec.
--
-- Form fields live in task_form_fields, keyed to a task_templates row. There are
-- two mortgage templates (one per side):
--   * Sale     "Status of Mortgage"               (still old name)
--   * Purchase "Mortgage Representative Details"   (already renamed)
-- Both carry the same 5 fields, so we reuse the existing rows and only relabel /
-- re-flag them rather than dropping and re-seeding.
--
-- Changes (no deletes — "Company Name" is intentionally left in place for a
-- later migration):
--   1. Rename the Sale template + every live task row to
--      "Mortgage Representative Details".
--   2. Relabel the agent name / phone / email fields.
--   3. Make the email field mandatory (required: false -> true).
--
-- All field updates are scoped to the mortgage templates so generic labels like
-- "Phone Number" / "Email Address" on other task templates are untouched.
--
-- Idempotent: safe to re-run.

-- 1a. Rename the Sale-side template to match the Purchase side.
UPDATE task_templates
  SET name = 'Mortgage Representative Details'
  WHERE name ILIKE 'Status of Mortgage';

-- 1b. Rename the per-deal task rows so existing deals show the new title.
UPDATE tasks
  SET title = 'Mortgage Representative Details'
  WHERE title ILIKE 'Status of Mortgage';

-- Scope helper: both mortgage templates by their (new) name.
-- 2 + 3. Relabel the agent name and phone fields.
UPDATE task_form_fields
  SET label = 'Mortgage Representative/Agent Name'
  WHERE label = 'Mortgage Agent Name'
    AND task_template_id IN (
      SELECT id FROM task_templates WHERE name ILIKE 'Mortgage Representative Details'
    );

UPDATE task_form_fields
  SET label = 'Mortgage Representative/Agent Phone Number'
  WHERE label = 'Phone Number'
    AND task_template_id IN (
      SELECT id FROM task_templates WHERE name ILIKE 'Mortgage Representative Details'
    );

-- 4. Relabel the email field AND make it mandatory.
UPDATE task_form_fields
  SET label = 'Mortgage Representative/Agent Email',
      required = TRUE
  WHERE label = 'Email Address'
    AND task_template_id IN (
      SELECT id FROM task_templates WHERE name ILIKE 'Mortgage Representative Details'
    );

-- Keep already-submitted answers' denormalized labels in sync with the fields
-- they reference (display-only; responses are matched by field_id, not label).
UPDATE task_responses tr
  SET field_label = tff.label
  FROM task_form_fields tff
  WHERE tr.field_id = tff.id
    AND tff.task_template_id IN (
      SELECT id FROM task_templates WHERE name ILIKE 'Mortgage Representative Details'
    )
    AND tr.field_label IS DISTINCT FROM tff.label;
