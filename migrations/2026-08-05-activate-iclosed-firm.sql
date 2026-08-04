-- Make the iClosed firm selectable.
--
-- 2026-08-03-closing-cost-firms-and-statement-types.sql deliberately seeds
-- iClosed with is_active = false. That is a DEPLOY-WINDOW guard, not a business
-- decision: the build running before that release reads the configuration with
--
--     .from("closing_cost_config").eq("is_active", true).maybeSingle()
--
-- and `.maybeSingle()` ERRORS when two rows match. The error handler falls back
-- to the code defaults, so a second active firm would have quietly switched
-- every live estimate onto default rates with nothing in the logs.
--
-- Once the release that resolves firms by `firm_key` is live that risk is gone,
-- and iClosed can be switched on. This file is the same thing as ticking
-- "Active" on the iClosed tab in Settings → Closing Costs — it just makes the
-- change repeatable across environments.
--
-- ⚠ RUN ONLY AFTER the firms release is confirmed live.
--
-- Idempotent: safe to re-run.

-- Refuse to run before the firm split exists, rather than silently doing
-- nothing and leaving someone to wonder why the picker is still single.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'closing_cost_config'
       AND column_name  = 'firm_key'
  ) THEN
    RAISE EXCEPTION
      'closing_cost_config.firm_key does not exist — run 2026-08-03-closing-cost-firms-and-statement-types.sql first';
  END IF;
END $$;

-- Guarded on the letterhead so this can never publish placeholder text on a
-- client's statement of account. iClosed is a DIVISION of Nava Wilson and is
-- seeded with the same address, telephone, fax and HST number, so on a normal
-- install this passes; if someone has since blanked a field, it stays inactive.
UPDATE closing_cost_config
   SET is_active  = true,
       updated_at = now()
 WHERE firm_key   = 'iclosed'
   AND is_deleted = false
   AND is_active  = false
   AND coalesce(btrim(firm_name), '')       <> ''
   AND coalesce(btrim(firm_address), '')    <> ''
   AND coalesce(btrim(firm_hst_number), '') <> ''
   AND firm_name       NOT LIKE 'SET %'
   AND firm_address    NOT LIKE 'SET %'
   AND firm_hst_number NOT LIKE 'SET %';

-- Verify: both firms should come back with is_active = true.
--   SELECT firm_key, label, is_active, brand_color
--     FROM closing_cost_config
--    WHERE is_deleted = false
--    ORDER BY sort_order;
