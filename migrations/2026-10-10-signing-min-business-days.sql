-- Signing appointments must be booked at least N business days before the
-- closing date. N is admin-configurable (Settings > Signing). 0 turns the rule
-- off. Default 3 per the client requirement.
--
-- Idempotent: safe to re-run.

ALTER TABLE signing_settings
  ADD COLUMN IF NOT EXISTS min_business_days_before_closing integer NOT NULL DEFAULT 3
  CHECK (min_business_days_before_closing >= 0 AND min_business_days_before_closing <= 30);

-- Verification. Must return a row.
SELECT column_name, column_default FROM information_schema.columns
WHERE table_name = 'signing_settings' AND column_name = 'min_business_days_before_closing';
