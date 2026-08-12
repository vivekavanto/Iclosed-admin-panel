-- 2026-08-12 — drop the "— RESIDENTIAL PURCHASE (ONTARIO)" qualifier from the
-- printed statement heading.
--
-- WHY THIS IS A MIGRATION AND NOT JUST A CODE CHANGE
-- The heading on every closing-cost PDF is `closing_cost_statement_types.title`.
-- The strings in src/lib/closingCostSettings.ts are only the fallback used when
-- that row cannot be read, so editing the code alone changes nothing on a
-- database that already has these rows — which is every environment, since
-- migrations/2026-08-03-closing-cost-firms-and-statement-types.sql seeded them.
--
-- Same shape as the code defaults after this change:
--   draft → ESTIMATED CLOSING COSTS
--   final → STATEMENT OF ACCOUNT
--
-- Staff can also edit these in Settings → Closing costs → Statement types; this
-- migration just moves the two seeded rows to the new wording.
--
-- Idempotent: matching on the OLD value means a re-run, or a run against a row a
-- staff member has since reworded by hand, is a no-op rather than a clobber.
--
-- Already-ISSUED statements are unaffected: their heading was frozen into
-- `deal_closing_estimates.config_snapshot` at issue time, and reprinting one
-- must reproduce the document the client received.

UPDATE closing_cost_statement_types
   SET title = 'ESTIMATED CLOSING COSTS'
 WHERE type_key = 'draft'
   AND title = 'ESTIMATED CLOSING COSTS — RESIDENTIAL PURCHASE (ONTARIO)';

UPDATE closing_cost_statement_types
   SET title = 'STATEMENT OF ACCOUNT'
 WHERE type_key = 'final'
   AND title = 'STATEMENT OF ACCOUNT — RESIDENTIAL PURCHASE (ONTARIO)';

-- Verify:
--   SELECT type_key, title FROM closing_cost_statement_types WHERE is_deleted = false;
