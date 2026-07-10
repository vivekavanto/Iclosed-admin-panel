-- Referral attribution: link a lead (and, on conversion, its deal) to the
-- broker + coupon that referred it.
--
-- At intake, when the customer picks "Real estate agent" / "Mortgage broker"
-- under "How did you hear about us?" and applies a valid referral (coupon) code,
-- the web app resolves the referring broker and stores both ids on the LEAD.
-- convertLead() then copies them onto the DEAL so admins can see who referred
-- each file. Attribution only — no discount is applied here.
--
-- FKs use ON DELETE SET NULL so soft-deleting/removing a broker or coupon master
-- never blocks or cascades into leads/deals; the link simply clears.
--
-- Idempotent: safe to re-run.

-- broker_id / coupon_id  → resolved from an applied referral code (masters).
-- referral_agent_*        → free-text details for the "I don't have a code" path,
--                           where the client names an off-system agent/broker so
--                           staff can still credit and update them.

-- ── leads ────────────────────────────────────────────────────────────
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS broker_id UUID REFERENCES brokers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_agent_name    TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_company TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_email   TEXT;

CREATE INDEX IF NOT EXISTS leads_broker_id_idx ON leads (broker_id);
CREATE INDEX IF NOT EXISTS leads_coupon_id_idx ON leads (coupon_id);

-- ── deals ────────────────────────────────────────────────────────────
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS broker_id UUID REFERENCES brokers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS coupon_id UUID REFERENCES coupons(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_agent_name    TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_company TEXT,
  ADD COLUMN IF NOT EXISTS referral_agent_email   TEXT;

CREATE INDEX IF NOT EXISTS deals_broker_id_idx ON deals (broker_id);
CREATE INDEX IF NOT EXISTS deals_coupon_id_idx ON deals (coupon_id);
