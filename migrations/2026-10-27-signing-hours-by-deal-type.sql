-- Per-deal-type signing availability.
--
-- A lawyer's weekly hours (signing_lawyer_hours) were one schedule for every
-- signing. deal_type lets a lawyer also have a Purchase schedule and/or a Sale
-- schedule. NULL = the default schedule, which is every row that exists today,
-- so nothing changes until an admin saves a purchase/sale schedule. A deal type
-- with no rows of its own falls back to the default schedule in code.
--
-- Safe to run before the code deploys: existing reads/writes ignore the column.

ALTER TABLE signing_lawyer_hours
  ADD COLUMN IF NOT EXISTS deal_type text
  CHECK (deal_type IS NULL OR deal_type IN ('purchase', 'sale'));

-- One row per (lawyer, deal type, day). NULL deal_type is a distinct value of
-- its own here, hence the COALESCE (a plain UNIQUE treats NULLs as different).
ALTER TABLE signing_lawyer_hours
  DROP CONSTRAINT IF EXISTS signing_lawyer_hours_lawyer_id_day_of_week_key;

CREATE UNIQUE INDEX IF NOT EXISTS signing_lawyer_hours_lawyer_type_day_key
  ON signing_lawyer_hours (lawyer_id, COALESCE(deal_type, ''), day_of_week);

-- Verify: deal_type_col_ok should be true; every pre-existing row has NULL.
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'signing_lawyer_hours' AND column_name = 'deal_type'
  ) AS deal_type_col_ok,
  (SELECT count(*) FROM signing_lawyer_hours WHERE deal_type IS NULL) AS default_rows;
