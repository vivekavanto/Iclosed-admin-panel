-- Seed the client-facing questions for the "Rental Equipment Information" task.
--
-- Questions live in task_form_fields, keyed to a task_templates row by
-- task_template_id. The client portal renders one input per field; each answer
-- is stored in task_responses (task_id + field_id). The admin Edit Task modal
-- reads the same fields via GET /api/admin/task-form-fields.
--
-- There may be more than one matching template (one per lead_type, e.g.
-- Purchase / Sale). Every matching template gets the same questions.
--
-- Idempotent: each field is only inserted when a field with the same label
-- doesn't already exist on the template, so re-running won't create duplicates.

begin;

-- Target the rental-equipment template(s) by name (case/space-insensitive).
with target_templates as (
  select id
  from task_templates
  where is_deleted = false
    and lower(trim(name)) = 'rental equipment information'
)

-- 1) Hot water tank: rented or owned (select Rented / Owned), required.
insert into task_form_fields (task_template_id, field_type, label, placeholder, required, order_index, options)
select t.id, 'select', 'Is the hot water tank rented or owned?', null, true, 1,
       '[{"value":"Rented","label":"Rented"},{"value":"Owned","label":"Owned"}]'::jsonb
from target_templates t
where not exists (
  select 1
  from task_form_fields f
  where f.task_template_id = t.id
    and lower(trim(f.label)) = 'is the hot water tank rented or owned?'
);

-- 2) Hot water tank provider (only relevant when rented).
insert into task_form_fields (task_template_id, field_type, label, placeholder, required, order_index, options)
select t.id, 'text', 'If rented, who is the hot water tank provider?', 'Provider name', false, 2, null
from task_templates t
where t.is_deleted = false
  and lower(trim(t.name)) = 'rental equipment information'
  and not exists (
    select 1
    from task_form_fields f
    where f.task_template_id = t.id
      and lower(trim(f.label)) = 'if rented, who is the hot water tank provider?'
  );

-- 3) Any other rental equipment at the property (select Yes / No), required.
insert into task_form_fields (task_template_id, field_type, label, placeholder, required, order_index, options)
select t.id, 'select', 'Is there any other rental equipment at the property?', null, true, 3,
       '[{"value":"Yes","label":"Yes"},{"value":"No","label":"No"}]'::jsonb
from task_templates t
where t.is_deleted = false
  and lower(trim(t.name)) = 'rental equipment information'
  and not exists (
    select 1
    from task_form_fields f
    where f.task_template_id = t.id
      and lower(trim(f.label)) = 'is there any other rental equipment at the property?'
  );

-- 4) Other equipment details + provider (free text).
insert into task_form_fields (task_template_id, field_type, label, placeholder, required, order_index, options)
select t.id, 'textarea', 'If yes, list the other rental equipment and its provider',
       'e.g. Furnace — Reliance; Water softener — EnerCare', false, 4, null
from task_templates t
where t.is_deleted = false
  and lower(trim(t.name)) = 'rental equipment information'
  and not exists (
    select 1
    from task_form_fields f
    where f.task_template_id = t.id
      and lower(trim(f.label)) = 'if yes, list the other rental equipment and its provider'
  );

-- 5) Enforce display order (also fixes order on any pre-existing rows).
update task_form_fields
set order_index = 1
where task_template_id in (select id from task_templates where is_deleted = false and lower(trim(name)) = 'rental equipment information')
  and lower(trim(label)) = 'is the hot water tank rented or owned?';

update task_form_fields
set order_index = 2
where task_template_id in (select id from task_templates where is_deleted = false and lower(trim(name)) = 'rental equipment information')
  and lower(trim(label)) = 'if rented, who is the hot water tank provider?';

update task_form_fields
set order_index = 3
where task_template_id in (select id from task_templates where is_deleted = false and lower(trim(name)) = 'rental equipment information')
  and lower(trim(label)) = 'is there any other rental equipment at the property?';

update task_form_fields
set order_index = 4
where task_template_id in (select id from task_templates where is_deleted = false and lower(trim(name)) = 'rental equipment information')
  and lower(trim(label)) = 'if yes, list the other rental equipment and its provider';

commit;
