-- Per-line "is estimate" flags on a closing-cost estimate
-- ---------------------------------------------------------------------------
-- Four lines on a draft statement carry the ESTIMATE chip: the title insurance
-- premium, Teraview searches, the Sheriff's certificates and the property tax &
-- common expense adjustment. Which ones were badged used to be decided by the
-- code alone — the title premium lost its chip the moment someone pasted the
-- real FCT quote, and the other three were always badged. Staff had no say.
--
-- These columns give them one: a checkbox per line in the "Adjust fees" panel,
-- saved with the estimate, honoured on screen and in the PDF.
--
-- NULLABLE ON PURPOSE, with no default. NULL means "nobody has said", and the
-- calculation then falls back to exactly the old behaviour:
--   • title premium → badged unless an override was typed
--   • the other three → badged
-- so every estimate saved before this migration reads back the way it was
-- issued. A final account still suppresses every chip regardless: nothing on it
-- is provisional.
--
-- Apply in the Supabase SQL editor BEFORE deploying the code that writes them —
-- an unknown column fails the whole save. Safe to re-run.

ALTER TABLE deal_closing_estimates
  ADD COLUMN IF NOT EXISTS title_premium_is_estimate BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS teraview_is_estimate      BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS sheriff_is_estimate       BOOLEAN NULL,
  ADD COLUMN IF NOT EXISTS property_tax_is_estimate  BOOLEAN NULL;

COMMENT ON COLUMN deal_closing_estimates.title_premium_is_estimate IS
  'Show the ESTIMATE chip on the title insurance premium. NULL = derive (badged unless a premium override was entered).';
COMMENT ON COLUMN deal_closing_estimates.teraview_is_estimate IS
  'Show the ESTIMATE chip on Teraview searches. NULL = derive (badged).';
COMMENT ON COLUMN deal_closing_estimates.sheriff_is_estimate IS
  'Show the ESTIMATE chip on the Sheriff''s certificates. NULL = derive (badged).';
COMMENT ON COLUMN deal_closing_estimates.property_tax_is_estimate IS
  'Show the ESTIMATE chip on the property tax & common expense adjustment. NULL = derive (badged).';

-- Verify:
--   SELECT id, status, statement_type,
--          title_premium_is_estimate, teraview_is_estimate,
--          sheriff_is_estimate, property_tax_is_estimate
--     FROM deal_closing_estimates
--    ORDER BY updated_at DESC
--    LIMIT 20;
