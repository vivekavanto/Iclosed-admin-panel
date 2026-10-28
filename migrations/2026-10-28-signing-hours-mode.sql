-- Signing availability mode: a lawyer's hours are EITHER the Default schedule OR
-- custom Purchase/Sale schedules, never a blend.
--
--   default -> every signing uses the default weekly hours; Purchase/Sale rows
--              (if any) are kept but ignored.
--   custom  -> Purchase and Sale signings use ONLY their own hours (no fallback
--              to default; a side with no hours has no availability). Refinance
--              and anything else still use the default rows.
--
-- Run in the Supabase SQL editor BEFORE deploying the code that reads/writes it.
-- Until then reads fall back to the old "own rows else default" behaviour and
-- saving a mode fails with 42703. Requires 2026-10-27-signing-hours-by-deal-type.sql.

ALTER TABLE signing_lawyers
  ADD COLUMN IF NOT EXISTS hours_mode text NOT NULL DEFAULT 'default'
  CHECK (hours_mode IN ('default', 'custom'));

-- Keep today's behaviour for lawyers who already have a Purchase and/or Sale
-- schedule: those types fall back to default when they have no rows, so copy the
-- default rows into the missing side before switching them to strict custom mode.
INSERT INTO signing_lawyer_hours (lawyer_id, day_of_week, start_time, end_time, deal_type)
SELECT d.lawyer_id, d.day_of_week, d.start_time, d.end_time, t.deal_type
FROM signing_lawyer_hours d
CROSS JOIN (VALUES ('purchase'), ('sale')) AS t(deal_type)
WHERE d.deal_type IS NULL
  AND EXISTS (SELECT 1 FROM signing_lawyer_hours x
              WHERE x.lawyer_id = d.lawyer_id AND x.deal_type IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM signing_lawyer_hours y
                  WHERE y.lawyer_id = d.lawyer_id AND y.deal_type = t.deal_type);

UPDATE signing_lawyers l
SET hours_mode = 'custom'
WHERE EXISTS (SELECT 1 FROM signing_lawyer_hours h
              WHERE h.lawyer_id = l.id AND h.deal_type IS NOT NULL);

-- Verify: hours_mode_col_ok should be true.
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'signing_lawyers' AND column_name = 'hours_mode'
  ) AS hours_mode_col_ok,
  (SELECT count(*) FROM signing_lawyers WHERE hours_mode = 'custom') AS custom_lawyers;
