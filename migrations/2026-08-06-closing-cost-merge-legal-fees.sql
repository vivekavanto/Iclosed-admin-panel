-- Closing-cost calculator: `legal_transfer` + `legal_mortgage` become ONE
-- `legal_fees` amount.
--
-- ── WHAT CHANGES FOR A CLIENT ──────────────────────────────────────────
--
-- src/lib/closingCosts.ts used to compute:
--
--     legalFees = legal_transfer + (hasMortgage ? legal_mortgage : 0)
--
-- so a CASH purchase was quoted the transfer portion alone ($650 on the stock
-- schedule) while a financed one paid both ($1,200). There is now a single fee
-- and a cash purchase pays it in full.
--
-- This is a real pricing change, not a refactor. CALC_VERSION is bumped 3 → 4
-- so a snapshot written either side of it is distinguishable in data.
--
-- Estimates already issued are NOT touched: they render from their own frozen
-- `line_items`, never by recomputing, so every figure a client has been sent
-- stays exactly as sent.
--
-- ── DEPLOY ORDER (this file is safe to run at any point) ───────────────
--
-- Same hazard as 2026-08-03: dropping a column the live build still reads makes
-- it fall back to code defaults SILENTLY — every estimate would quietly switch
-- to the stock fee schedule. So the old pair is NOT dropped here. That is a
-- separate, later file (2026-08-07-closing-cost-drop-legal-fee-split.sql), run
-- once the new build is live.
--
-- Until then both shapes sit on the row and are kept in step by the app:
-- `ratesFromConfigRow` prefers `legal_fees` whenever it is present, so a
-- settings edit takes effect immediately, and falls back to summing the pair
-- for any row written before this migration.
--
-- Idempotent: safe to re-run. The backfill is guarded on NULL so a second run
-- never overwrites a fee that has since been edited.

-- ─────────────────────────────────────────────────────────────────────
-- 1. The merged column
-- ─────────────────────────────────────────────────────────────────────
-- No NOT NULL and no DEFAULT yet: a default would fire on the ADD and make the
-- "has this been backfilled?" guard below meaningless.
ALTER TABLE closing_cost_config
  ADD COLUMN IF NOT EXISTS legal_fees numeric;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Backfill from the pair
-- ─────────────────────────────────────────────────────────────────────
-- The sum is what the firm charged a MORTGAGE purchase, which is the schedule
-- staff quote from and the one the stock $1,200 comes from. Carrying the
-- transfer figure alone would be a silent price cut on every financed file.
--
-- Wrapped in a DO block so this file stays re-runnable after the follow-up
-- migration has dropped the pair: referencing a dropped column in plain SQL is
-- a parse error, so the update only runs while they still exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'closing_cost_config'
       AND column_name  = 'legal_transfer'
  ) THEN
    EXECUTE $q$
      UPDATE closing_cost_config
         SET legal_fees = coalesce(legal_transfer, 0) + coalesce(legal_mortgage, 0)
       WHERE legal_fees IS NULL
    $q$;
  END IF;
END $$;

-- A fresh database where the columns never existed, or a row somehow missed.
UPDATE closing_cost_config
   SET legal_fees = 1200
 WHERE legal_fees IS NULL;

-- Now it can carry the same guarantees the pair did. The default mirrors
-- src/lib/closingCosts.ts DEFAULT_RATES.legalFees, which
-- tests/closingCostSettings.test.ts asserts.
ALTER TABLE closing_cost_config
  ALTER COLUMN legal_fees SET DEFAULT 1200,
  ALTER COLUMN legal_fees SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 3. The old pair stays, for now
-- ─────────────────────────────────────────────────────────────────────
-- Deliberately no DROP here — see the deploy-order note at the top. They are
-- stale but harmless the moment the new build is live, because the app always
-- lets `legal_fees` win.
