-- Allow "refinance" as a signing appointment transaction type.
-- (side stays purchase/sale only: a refinance has no purchase/sale side.)
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE signing_appointments DROP CONSTRAINT IF EXISTS signing_appointments_deal_type_check;
ALTER TABLE signing_appointments
  ADD CONSTRAINT signing_appointments_deal_type_check
  CHECK (deal_type IS NULL OR deal_type IN ('purchase', 'sale', 'refinance'));

COMMIT;

-- Verification: the definition must list purchase, sale, refinance.
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conname = 'signing_appointments_deal_type_check';
