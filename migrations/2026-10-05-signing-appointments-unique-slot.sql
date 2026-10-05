-- Prevent double-booking the same lawyer's same slot.
--
-- src/app/api/signing/appointments/route.ts re-checks availability
-- (isSlotStillAvailable) right before creating the Google Calendar event, but
-- that check-then-act has no lock: two requests arriving within milliseconds
-- of each other for the same lawyer/start_at can both pass the check, both
-- create a Google Calendar event, and both insert a signing_appointments row.
--
-- A unique index on (lawyer_id, start_at) scoped to confirmed rows turns the
-- second insert into a 23505 unique_violation, which the route now catches
-- and turns into a 409 "slot already taken" response (and deletes the
-- already-created duplicate calendar event). This replaces the plain,
-- non-unique index of the same shape added in
-- 2026-10-01-signing-appointments.sql.
--
-- Idempotent: safe to re-run.

BEGIN;

DROP INDEX IF EXISTS signing_appointments_lawyer_window_idx;

CREATE UNIQUE INDEX IF NOT EXISTS signing_appointments_lawyer_slot_unique
  ON signing_appointments (lawyer_id, start_at)
  WHERE status = 'confirmed';

COMMIT;

-- Verification.
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'signing_appointments'
  AND indexname = 'signing_appointments_lawyer_slot_unique';
