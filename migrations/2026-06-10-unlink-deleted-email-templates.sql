-- Clean up dangling email-template references.
--
-- Deleting an email template is a soft delete (email_templates.deleted = true),
-- but until now it left the email_template_id FK intact on every stage_template
-- and milestone that pointed at it. The admin milestone-templates page and the
-- deal detail page join `email_templates(id, name)` without filtering on
-- `deleted`, so a deleted template kept showing up as if still linked.
--
-- The DELETE route now nulls these references going forward; this migration
-- fixes the rows orphaned before that change shipped.
--
-- Idempotent: safe to re-run (only touches rows still pointing at a deleted
-- template).

UPDATE stage_templates st
SET email_template_id = NULL
FROM email_templates et
WHERE st.email_template_id = et.id
  AND et.deleted = true;

UPDATE milestones m
SET email_template_id = NULL
FROM email_templates et
WHERE m.email_template_id = et.id
  AND et.deleted = true;
