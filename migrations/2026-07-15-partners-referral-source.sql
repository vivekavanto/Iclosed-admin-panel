-- Make `partners` the referral-source master.
--
-- History: 2026-07-08 created `brokers` + `coupons`, and the Partners UI/API
-- (2026-07-10) stored its rows in `brokers` even though it was already called
-- "Partners" — because a `partners` table already existed with a different shape
-- and was unused. `brokers` and `coupons` have since been dropped, so this file
-- aligns name and storage: `partners` becomes the master.
--
-- `coupons` is not replaced. It modelled a SHARED discount code (one coupon →
-- many brokers, with discount_type/value), which 2026-07-10 already superseded
-- with a per-partner referral_code. Nothing ever computed a discount.
--
-- A partner is a referral source (Mortgage Broker / Real Estate Agent) owning
-- one unique referral_code. Unlimited clients may apply that code — the code
-- identifies the partner, which is the leads.partner_id / deals.partner_id link.
--
-- Run this on EVERY environment. It supersedes 2026-07-08 and 2026-07-10, whose
-- brokers/coupons objects no longer exist; do not run those.
--
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- partners — create at target shape, or bring the existing table up to it
--
-- agent_* is the person, brokerage_* the firm. Only agent_name is required.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_name TEXT,
  brokerage_type TEXT,
  agent_name     TEXT,
  agent_email    TEXT,
  agent_phone    TEXT,
  referral_code  TEXT,
  is_deleted     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Where partners already exists in its original 7-column shape, add the three
-- columns the Partners feature depends on:
--   referral_code — the feature itself; generated on create, emailed to the
--                   partner, matched at intake.
--   is_deleted    — the admin delete is a SOFT delete; without this the row
--                   would be destroyed and every lead/deal pointing at it would
--                   lose its referral.
--   updated_at    — written unconditionally by the PUT and DELETE handlers.
ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS referral_code TEXT,
  ADD COLUMN IF NOT EXISTS is_deleted    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMPTZ NOT NULL DEFAULT now();

-- brokerage_name holds the firm, which is optional in the admin UI (only the
-- agent's name is required), so it must be nullable — the original partners
-- table declared it NOT NULL.
ALTER TABLE partners
  ALTER COLUMN brokerage_name DROP NOT NULL;

-- The admin UI's type tabs and header counts compare brokerage_type against
-- these exact literals, so an unconstrained value silently drops a partner out
-- of both tabs. NULL passes — partners with no type set stay blank.
--
-- NOT VALID on purpose: an environment may already hold rows with other values,
-- and a plain ADD CONSTRAINT would abort the whole script on the first one. NOT
-- VALID enforces the rule on every INSERT/UPDATE from now on while tolerating
-- existing rows. To promote it later, check for legacy values:
--     SELECT DISTINCT brokerage_type FROM partners;
-- clean anything that isn't one of the two below (or NULL), then:
--     ALTER TABLE partners VALIDATE CONSTRAINT partners_brokerage_type_check;
DO $$
BEGIN
  ALTER TABLE partners
    ADD CONSTRAINT partners_brokerage_type_check
    CHECK (brokerage_type IN ('Mortgage Broker', 'Real Estate Agent'))
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One live code per partner, case-insensitive. Soft-deleted rows are excluded so
-- a code frees up on delete; NULLs don't collide (Postgres treats them as
-- distinct), so code-less partners coexist fine. The POST handler generates
-- codes optimistically and retries on 23505, so it depends on this index.
--
-- If this errors with "could not create unique index", duplicate codes exist:
--   SELECT lower(referral_code), count(*) FROM partners
--   WHERE is_deleted = false AND referral_code IS NOT NULL
--   GROUP BY 1 HAVING count(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS partners_referral_code_unique_idx
  ON partners (lower(referral_code))
  WHERE is_deleted = false;

-- ─────────────────────────────────────────────────────────────────────
-- leads / deals → partners
--
-- partner_id is set at intake from the applied referral code and copied onto the
-- deal by convertLead(). ON DELETE SET NULL so removing a partner master clears
-- the link rather than cascading into client files.
--
-- referral_agent_* are the free-text "I don't have a code" fields, where the
-- client names an off-system agent. Included because they ship with this feature
-- and Leads.tsx / DealDetail.tsx read them; harmless where they already exist.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_agent_name    TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_company TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_email   TEXT;

CREATE INDEX IF NOT EXISTS leads_partner_id_idx ON leads (partner_id);

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS partner_id UUID REFERENCES partners(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_agent_name    TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_company TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_email   TEXT;

CREATE INDEX IF NOT EXISTS deals_partner_id_idx ON deals (partner_id);

-- ─────────────────────────────────────────────────────────────────────
-- email_templates."shared_with_agent"
-- From 2026-07-13. Repeated here so an environment that never ran that file
-- still gets the column the milestone-email CC depends on. Idempotent.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS shared_with_agent BOOLEAN NOT NULL DEFAULT false;

-- ─────────────────────────────────────────────────────────────────────
-- Grants + RLS
-- ─────────────────────────────────────────────────────────────────────
-- Non-optional. 2026-07-08's header records that Supabase's default privileges
-- did NOT reach freshly-created tables, and even the service_role client hit
-- "permission denied for table" until granted explicitly. `partners` predates
-- that fix, so it has never been granted.
GRANT ALL ON partners TO anon, authenticated, service_role;

-- Admin-managed master. RLS ON with NO policies so the anon / authenticated
-- grants above can't read or write it through the public key; the admin API and
-- the web app's intake use the service_role key, which BYPASSES RLS.
ALTER TABLE partners ENABLE ROW LEVEL SECURITY;
