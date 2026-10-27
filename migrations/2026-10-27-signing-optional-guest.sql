-- Optional guest for signing appointments: one standing address added to every
-- signing calendar event as an OPTIONAL attendee (Google emails the invite and
-- any cancellation). Empty string = nobody.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that reads it. Until
-- then getSettings() falls back to '' (no optional guest), and saving the new
-- field from the admin screen fails with 42703.

ALTER TABLE signing_settings
  ADD COLUMN IF NOT EXISTS optional_guest_email text NOT NULL DEFAULT '';
