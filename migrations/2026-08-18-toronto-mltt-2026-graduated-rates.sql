-- Toronto MLTT: adopt the graduated luxury rates in force from 1 April 2026.
--
-- City council's 17 December 2025 amendment replaced the top five bands for
-- residential property containing at least one and not more than two
-- single-family residences. Everything at or below $3,000,000 is unchanged;
-- only the rates above it move:
--
--     $3,000,000.01 – $4,000,000    3.50%  →  4.40%
--     $4,000,000.01 – $5,000,000    4.50%  →  5.45%
--     $5,000,000.01 – $10,000,000   5.50%  →  6.50%
--     $10,000,000.01 – $20,000,000  6.50%  →  7.55%
--     over $20,000,000              7.50%  →  8.60%
--
-- The band EDGES are unchanged — the published table tops out at "over
-- $20,000,000", so there is no $40M band. Any stored row carrying one was hand
-- edited and is wrong; this migration replaces the whole array rather than
-- patching rates in place.
--
-- These are statutory rates, not a firm preference, so the UPDATE deliberately
-- overwrites whatever is stored. Matches DEFAULT_MLTT_TIERS in
-- src/lib/closingCosts.ts (both repos) — keep the two in step.
--
-- Idempotent: safe to re-run.

-- 1. Column default, for any row created from here on.
ALTER TABLE closing_cost_shared_rates
  ALTER COLUMN mltt_tiers SET DEFAULT
    '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.044],[5000000,0.0545],[10000000,0.065],[20000000,0.0755],[null,0.086]]'::jsonb;

-- 2. The live shared row (and any soft-deleted copy that could be restored).
UPDATE closing_cost_shared_rates
SET mltt_tiers =
      '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.044],[5000000,0.0545],[10000000,0.065],[20000000,0.0755],[null,0.086]]'::jsonb,
    updated_at = now()
WHERE mltt_tiers IS DISTINCT FROM
      '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.044],[5000000,0.0545],[10000000,0.065],[20000000,0.0755],[null,0.086]]'::jsonb;

-- 3. The legacy per-firm copy, only if 2026-08-04-…-drop-legacy-statutory-columns
--    has not run yet. Once dropped, the shared table is the only home.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'closing_cost_config' AND column_name = 'mltt_tiers'
  ) THEN
    EXECUTE $sql$
      UPDATE closing_cost_config
      SET mltt_tiers =
            '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.044],[5000000,0.0545],[10000000,0.065],[20000000,0.0755],[null,0.086]]'::jsonb,
          updated_at = now()
    $sql$;
  END IF;
END $$;
