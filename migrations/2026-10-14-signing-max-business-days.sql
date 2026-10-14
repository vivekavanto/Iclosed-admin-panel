-- Signing appointments can only be booked within a window before closing:
-- no earlier than max_business_days_before_closing business days before the
-- closing date (client requirement: 1-3 business days). Pairs with the existing
-- min_business_days_before_closing ("book at least N days before"). 0 = no limit.
--
-- The window is [closing - max, closing - min]. Leave min at 1 (Settings >
-- Signing) for the 1-3 day window; the old default of 3 would leave one day.
--
-- Idempotent: safe to re-run.

ALTER TABLE signing_settings
  ADD COLUMN IF NOT EXISTS max_business_days_before_closing integer NOT NULL DEFAULT 3
  CHECK (max_business_days_before_closing >= 0 AND max_business_days_before_closing <= 30);

-- Verification. Must return a row.
SELECT column_name, column_default FROM information_schema.columns
WHERE table_name = 'signing_settings' AND column_name = 'max_business_days_before_closing';
