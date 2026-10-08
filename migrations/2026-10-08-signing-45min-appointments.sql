-- Signing appointments: 45-minute duration on a 30-minute start grid.
--
-- Starts are offered at :00 and :30 only. A 10:00 booking occupies 10:00-10:45,
-- which also blocks the 10:30 start, so the next open slot is 11:00. The 15 min
-- left over before 11:00 is the turnaround time, so buffer is 0.
-- getAvailableSlots (signingAvailability.ts) reads these three values; no other
-- code change is needed. Existing confirmed appointments keep their stored
-- start_at/end_at.
--
-- Slots are anchored to each lawyer's window start (signing_lawyer_hours), so
-- a lawyer whose hours start at e.g. 10:15 would be offered :15/:45 starts.
-- Hours should start on :00 or :30.
--
-- Can also be done by hand in the admin Signing settings page.

BEGIN;

ALTER TABLE signing_settings
  ALTER COLUMN default_duration_minutes SET DEFAULT 45,
  ALTER COLUMN buffer_minutes           SET DEFAULT 0,
  ALTER COLUMN slot_increment_minutes   SET DEFAULT 30;

UPDATE signing_settings
SET default_duration_minutes = 45,
    buffer_minutes           = 0,
    slot_increment_minutes   = 30;

-- Verification: 45 / 0 / 30
SELECT default_duration_minutes, buffer_minutes, slot_increment_minutes
FROM signing_settings;

COMMIT;
