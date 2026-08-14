-- Allow more than one person to be CC'd on a file's emails.
--
-- Before this, CC was structurally single-valued: partners.agent_email is one
-- scalar column, and both CC call sites built a one-element array
-- (`cc = [partner.agent_email]`). A brokerage with an agent + an assistant, or
-- a file where a second party should be copied, had no way to express that.
--
-- Two additive pieces, matching the two real cases:
--   1. partner_contacts — extra people belonging to a partner. Auto-CC'd on
--      every file that partner referred. partners.agent_email stays as-is and
--      remains the PRIMARY contact (sendPartnerCodeEmail, the Partners list and
--      the duplicate-email check all still read it); this table holds the
--      ADDITIONAL people, so there is exactly one source of truth per address
--      and no sync problem between the two.
--   2. deals.cc_emails — per-file one-off addresses (a spouse, another lawyer)
--      that shouldn't be attached to the partner at all.
--
-- At send time the effective CC is the union of both, de-duped case-insensitively
-- and with the client's own address removed. See src/lib/agentCc.ts.
--
-- Additive only: no existing column is dropped or rewritten, so deploying the
-- code before or after this migration is safe (the helper tolerates both tables
-- being absent).

-- ── 1. Additional contacts belonging to a partner ───────────────────────────
CREATE TABLE IF NOT EXISTS partner_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id  uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name        text,
  email       text NOT NULL,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_contacts_partner_id_idx
  ON partner_contacts (partner_id)
  WHERE is_deleted = false;

-- One row per address per partner. Case-insensitive so "Jane@x.ca" can't be
-- added alongside "jane@x.ca" and produce a duplicate CC. Partial on
-- is_deleted = false so a removed contact can be re-added later.
CREATE UNIQUE INDEX IF NOT EXISTS partner_contacts_partner_email_unique_idx
  ON partner_contacts (partner_id, lower(email))
  WHERE is_deleted = false;

-- ── 2. Per-file extra CC addresses ──────────────────────────────────────────
-- text[] rather than a child table: this is a short, unordered list of bare
-- addresses with no attributes of its own, always read and written whole
-- alongside the deal.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS cc_emails text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN deals.cc_emails IS
  'Extra per-file CC addresses, merged with the partner''s contacts at send time. Only applied to templates with shared_with_agent = true; never to auth emails.';

COMMENT ON TABLE partner_contacts IS
  'Additional people for a partner beyond partners.agent_email (the primary). CC''d on shared_with_agent emails for every file that partner referred.';

-- ── 3. Grants ───────────────────────────────────────────────────────────────
-- Supabase's default privileges do NOT reach freshly-created tables here, so
-- even the service_role client hits "permission denied for table" (42501).
-- Mirrors 2026-07-08-create-brokers-and-coupons.sql and
-- 2026-07-30-closing-cost-calculator.sql.
--
-- This one fails QUIETLY without the grant, which is why it matters: agentCc.ts
-- treats a partner_contacts error as "no contacts" so a missing migration can't
-- block the client's email. Skip this and every additional CC is silently
-- dropped with only a logger.warn to show for it, while
-- /api/admin/partners/contacts returns a generic 500.
GRANT ALL ON partner_contacts TO anon, authenticated, service_role;

-- Admin-managed data. RLS ON with NO policies so the anon / authenticated
-- grants above can't read or write it through the public key; the admin API
-- uses the service_role key, which BYPASSES RLS and keeps working.
ALTER TABLE partner_contacts ENABLE ROW LEVEL SECURITY;
