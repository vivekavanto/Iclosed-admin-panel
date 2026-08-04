-- Closing-cost estimate: the statement header block, the Statement of
-- Adjustments property-tax line, and email-send auditing.
--
-- Pairs with the calculator redesign. Every column is nullable and unread by
-- the previous build, so this file is safe to run before OR after the deploy.
--
-- ── Where these figures show up ────────────────────────────────────────
--
--   purchasers / property_address / closing_date
--       Printed in the statement header alongside the file number and the
--       preparation date. They are captured on the ESTIMATE rather than read
--       from the deal because a statement is a point-in-time document: an
--       address corrected on the file next month must not silently rewrite a
--       statement already sent to the client.
--
--   property_tax_adjustment
--       A Statement of Adjustments item — the buyer's share of tax the seller
--       has already paid. NOT a fee, and it carries no HST. It may be NEGATIVE
--       when the seller is in arrears and credits the buyer instead, so there
--       is deliberately no non-negative constraint.
--
--       This is the reason CALC_VERSION moved to 2 in src/lib/closingCosts.ts.
--       The change is additive: with no adjustment the computed statement is
--       byte-identical to a version 1 one, and snapshotToStatement reads a
--       missing value back as 0.
--
--   last_emailed_at / last_emailed_to
--       Set by the "email the estimate" route. Sending a statement of account
--       to a client is an outward-facing act, so it leaves a trace on the row
--       as well as in audit_logs.
--
-- firm_key and statement_type were already added by
-- 2026-08-03-closing-cost-firms-and-statement-types.sql.
--
-- Idempotent: safe to re-run.

ALTER TABLE deal_closing_estimates
  -- Statement header
  ADD COLUMN IF NOT EXISTS purchasers        text,
  ADD COLUMN IF NOT EXISTS property_address  text,
  -- A plain date, never a timestamptz: the statement prints it and never does
  -- arithmetic with it, and a timestamp would drift a day across timezones.
  ADD COLUMN IF NOT EXISTS closing_date      date,

  -- Statement of Adjustments (may be negative — see the note above)
  ADD COLUMN IF NOT EXISTS property_tax_adjustment numeric,

  -- Email-send trace
  ADD COLUMN IF NOT EXISTS last_emailed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_emailed_to text;

-- No backfill and no defaults. A NULL here means "not captured", which reads
-- correctly on every estimate written before the redesign — those statements
-- genuinely had no header block and no adjustment, and rendering them must not
-- invent one.
