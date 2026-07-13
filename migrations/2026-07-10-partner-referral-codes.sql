-- Partner referral codes.
--
-- Each partner (row in `brokers` — a Mortgage Broker / Real Estate Agent) gets a
-- unique referral code that supersedes the coupon join for referral display.
-- Codes are generated per-prefix + sequential counter in the API (JS), matching
-- the file_number scan-max pattern, so there is no sequence/DEFAULT here.
--
-- Idempotent: safe to re-run. `brokers` already has table grants (see
-- 2026-07-08-create-brokers-and-coupons.sql), so none are needed here.

ALTER TABLE brokers
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- One live code per referral_code (case-insensitive). Soft-deleted rows are
-- excluded so a code can be reused after its partner is deleted. Mirrors
-- coupons_code_unique_idx.
CREATE UNIQUE INDEX IF NOT EXISTS brokers_referral_code_unique_idx
  ON brokers (lower(referral_code))
  WHERE is_deleted = false;
