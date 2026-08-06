-- Drop the legal fee columns that `legal_fees` replaced.
--
-- ⚠ RUN THIS LAST, and only once the release that reads `legal_fees` is
-- confirmed LIVE.
--
-- Same silent-failure ordering as 2026-08-04. The previous build reads this
-- pair through ratesFromConfigRow; drop them while it is still serving and
-- every estimate quietly falls back to the code defaults in
-- src/lib/closingCosts.ts — wrong figures to clients with nothing in the logs.
--
-- Until this file runs, the pair is stale but harmless: ratesFromConfigRow
-- always prefers `legal_fees` when the column is present, so the merged value
-- is authoritative from the moment the backfill has run.
--
-- Sequence:
--   1. Run 2026-08-06-closing-cost-merge-legal-fees.sql
--   2. Deploy, and confirm the new build is serving
--   3. Run this file
--
-- Idempotent: safe to re-run.

-- Refuse to run before the merged column is populated — otherwise this drops
-- the only copy of the live fee schedule.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'closing_cost_config'
       AND column_name  = 'legal_fees'
  ) THEN
    RAISE EXCEPTION
      'closing_cost_config.legal_fees does not exist — run 2026-08-06-closing-cost-merge-legal-fees.sql first';
  END IF;

  IF EXISTS (
    SELECT 1 FROM closing_cost_config
     WHERE is_deleted = false AND legal_fees IS NULL
  ) THEN
    RAISE EXCEPTION
      'closing_cost_config.legal_fees is not backfilled on every live row — re-run 2026-08-06-closing-cost-merge-legal-fees.sql first';
  END IF;
END $$;

ALTER TABLE closing_cost_config
  DROP COLUMN IF EXISTS legal_transfer,
  DROP COLUMN IF EXISTS legal_mortgage;
