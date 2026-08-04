-- Drop the statutory columns that closing_cost_config no longer owns.
--
-- ⚠ RUN THIS LAST, and only once the release that reads
-- closing_cost_shared_rates is confirmed LIVE.
--
-- Ordering matters because the failure is silent, not loud. The previous build
-- reads these columns through ratesFromConfigRow; drop them while it is still
-- serving and every estimate quietly falls back to the code defaults in
-- src/lib/closingCosts.ts — wrong figures to clients with nothing in the logs.
--
-- Until this file runs, those columns are stale but harmless: the app's merge
-- (mergeConfigRow in src/lib/closingCostSettings.ts) always lets
-- closing_cost_shared_rates win, so the shared table is authoritative from the
-- moment it is seeded.
--
-- Sequence:
--   1. Run 2026-08-03-closing-cost-firms-and-statement-types.sql
--   2. Deploy, and confirm the new build is serving
--   3. Run this file
--
-- Idempotent: safe to re-run.

-- Refuse to run before the shared row exists — otherwise this drops the only
-- copy of the live statutory values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM closing_cost_shared_rates WHERE is_active = true AND is_deleted = false
  ) THEN
    RAISE EXCEPTION
      'closing_cost_shared_rates is not seeded — run 2026-08-03-closing-cost-firms-and-statement-types.sql first';
  END IF;
END $$;

ALTER TABLE closing_cost_config
  DROP COLUMN IF EXISTS reg_transfer,
  DROP COLUMN IF EXISTS reg_mortgage,
  DROP COLUMN IF EXISTS hst_rate,
  DROP COLUMN IF EXISTS rebate_ontario_max,
  DROP COLUMN IF EXISTS rebate_toronto_max,
  DROP COLUMN IF EXISTS title_premium_base,
  DROP COLUMN IF EXISTS title_premium_rate,
  DROP COLUMN IF EXISTS title_premium_min,
  DROP COLUMN IF EXISTS ltt_tiers,
  DROP COLUMN IF EXISTS mltt_tiers;
