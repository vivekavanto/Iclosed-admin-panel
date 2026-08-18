-- Deposit amount — lead level and file level
-- ---------------------------------------------------------------------------
-- The intake form (portal Step 2 → Property Details) has always captured a
-- deposit, but it only ever landed on `leads`, and the admin app never read it:
-- the lead page showed Purchase Price with no deposit beside it, the file page
-- showed neither, and the closing-cost estimator asked staff to re-type
-- "Deposit already paid" that the client had already given us.
--
-- Two parts:
--   1. `leads.deposit_amount` / `leads.selling_deposit_amount` — created by the
--      customer portal's sql/add_lead_deposit_amount.sql. Repeated here (IF NOT
--      EXISTS) so this file alone is enough to bring a database up to date.
--   2. `deals.deposit_amount` — NEW. The file-level figure, seeded at conversion
--      from the lead and editable in Edit Deal, exactly how `deals.price`
--      relates to `leads.price`. Like price, it is the PURCHASE side's number: a
--      combined Purchase & Sale family keeps the sale deposit on the lead
--      (`selling_deposit_amount`), matching how `selling_price` works.
--
-- Both columns are NUMERIC NULL. NULL means "not provided", which is NOT the
-- same as 0 ("no deposit") — the estimator treats them differently, so nothing
-- here defaults to zero.
--
-- Apply in the Supabase SQL editor. Safe to re-run.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC NULL,
  ADD COLUMN IF NOT EXISTS selling_deposit_amount NUMERIC NULL;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS deposit_amount NUMERIC NULL;

COMMENT ON COLUMN deals.deposit_amount IS
  'Deposit already paid on the purchase, seeded from leads.deposit_amount at conversion. NULL = not provided (not zero).';

-- Backfill existing files from the deposit their lead already carries. Only
-- fills rows that have nothing yet, so a figure a clerk has since corrected on
-- the deal is never overwritten.
UPDATE deals d
   SET deposit_amount = l.deposit_amount
  FROM leads l
 WHERE d.lead_id = l.id
   AND d.deposit_amount IS NULL
   AND l.deposit_amount IS NOT NULL;

-- Verify:
--   SELECT d.file_number, d.price, d.deposit_amount, l.deposit_amount AS lead_deposit
--     FROM deals d
--     JOIN leads l ON l.id = d.lead_id
--    WHERE d.deposit_amount IS NOT NULL
--    ORDER BY d.created_at DESC
--    LIMIT 20;
 