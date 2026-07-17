-- Put "No (first time)" before "Yes" on the "Have you or your spouse ever owned
-- a property?" question.
--
-- The client portal (CustomSelect in PersonalInfoTaskDrawer) and the admin Edit
-- Task modal (parseFieldOptions in DealDetail) both render task_form_fields.options
-- in raw array order with no sort, so array order IS display order. Reordering
-- the array is the only way to reorder the dropdown.
--
-- Only the order changes: the stored values ("yes" / "no") are untouched, so
-- existing task_responses and any visible_when rules keyed on this field keep
-- working.
--
-- Targets every template carrying this question (matched by label, not id, so
-- this runs cleanly against both the dev and prod projects).
--
-- Idempotent: the where clause only matches rows still in the old order, so
-- re-running is a no-op.

begin;

update task_form_fields
set options = '[{"label":"No (first time)","value":"no"},{"label":"Yes","value":"yes"}]'::jsonb
where field_type = 'select'
  and lower(trim(label)) = 'have you or your spouse ever owned a property?'
  and options @> '[{"value":"yes"}]'::jsonb
  and options @> '[{"value":"no"}]'::jsonb
  and options -> 0 ->> 'value' = 'yes';

commit;
