-- Tear down the signing-appointment booking feature (reverted in code on both
-- the admin and portal repos). Run the verification query below FIRST and
-- adjust the DROP list if any name doesn't match what's actually in the DB —
-- this is reconstructed from the application code, not the original migration
-- file, which was never committed and is unrecoverable.

-- 1) Verify what actually exists before dropping anything:
--   select table_name from information_schema.tables where table_name like 'signing_%';

drop table if exists signing_appointment_events cascade;
drop table if exists signing_appointments cascade;
drop table if exists signing_blocked_times cascade;
drop table if exists signing_lawyer_hours cascade;
drop table if exists signing_lawyers cascade;
drop table if exists signing_settings cascade;

-- 2) Remove 'signing_manage' from invitation_tokens' type check constraint,
-- if the original migration added it there. Check the constraint's current
-- definition first:
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'invitation_tokens'::regclass and contype = 'c';
--
-- Then, with the real constraint name substituted:
-- alter table invitation_tokens drop constraint invitation_tokens_type_check;
-- alter table invitation_tokens add constraint invitation_tokens_type_check
--   check (type in ('invite','recovery','retainer_sign','final_report','doc_link'));
