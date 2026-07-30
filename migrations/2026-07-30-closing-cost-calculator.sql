-- Purchase Closing Cost Calculator — firm-standard rate config + per-deal
-- estimates.
--
-- Staff prepare a residential-purchase closing-cost estimate for a file (5
-- client inputs: purchase price, deposit paid, mortgage amount, Toronto?,
-- first-time buyer?) and the app derives the whole statement of account —
-- land transfer tax, first-time-buyer rebates, FCT title premium,
-- third-party disbursements, legal & admin fees, HST, and the balance the
-- buyer must bring to closing.
--
-- TWO tables, mirroring the template-vs-snapshot split this codebase already
-- uses for stage_templates→milestones and task_templates→tasks:
--
--   closing_cost_config     the firm's CURRENT rates/fees. One active row,
--                           edited from /admin/settings/closing-costs. Rates
--                           are config (not hard-coded constants) so a
--                           statutory bracket change never needs a deploy.
--
--   deal_closing_estimates  a per-deal estimate whose computed line items AND
--                           the rates that produced them are FROZEN as jsonb.
--                           Never recomputed on read. This is the whole point:
--                           bumping the admin fee next month must not silently
--                           rewrite an estimate already sent to a client.
--
-- The customer portal (iclosed_dev_web) reads deal_closing_estimates directly
-- with its own service-role client — same DB, no cross-app API call.
--
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- closing_cost_config — firm-standard rates & fees (one active row)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closing_cost_config (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                   text NOT NULL DEFAULT 'Firm standard',

  -- Third-party disbursements: government + search costs the firm pays on the
  -- client's behalf. reg_mortgage is only charged when a mortgage exists.
  reg_transfer            numeric NOT NULL DEFAULT 85,
  reg_mortgage            numeric NOT NULL DEFAULT 85,
  teraview                numeric NOT NULL DEFAULT 54.80,
  sheriff                 numeric NOT NULL DEFAULT 133.60,

  -- Legal & admin fees (the firm's own charges). The client-facing "Legal fees"
  -- line is transfer + mortgage + title submission, so it reads $1,350 with a
  -- mortgage and $800 on a cash purchase.
  legal_transfer          numeric NOT NULL DEFAULT 650,
  legal_mortgage          numeric NOT NULL DEFAULT 550,
  legal_title_submission  numeric NOT NULL DEFAULT 150,
  admin_fee               numeric NOT NULL DEFAULT 250,

  -- Rates & caps.
  hst_rate                numeric NOT NULL DEFAULT 0.13,
  rebate_ontario_max      numeric NOT NULL DEFAULT 4000,
  rebate_toronto_max      numeric NOT NULL DEFAULT 4475,

  -- FCT title-insurance premium approximation:
  --   max(title_premium_min, title_premium_base + price * title_premium_rate)
  -- A per-file override on the estimate replaces this entirely.
  title_premium_base      numeric NOT NULL DEFAULT 250,
  title_premium_rate      numeric NOT NULL DEFAULT 0.000785,
  title_premium_min       numeric NOT NULL DEFAULT 300,

  -- Marginal land-transfer-tax brackets as [[cap, rate], ...] — each rate
  -- applies only to the portion of the price within that band.
  --
  -- JSON has no Infinity, so the FINAL tier's cap is null, meaning "and above".
  -- src/lib/closingCosts.ts maps null → Infinity; the config PUT route rejects
  -- any tier array that doesn't end in exactly one null cap.
  ltt_tiers   jsonb NOT NULL DEFAULT
    '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[null,0.025]]'::jsonb,
  mltt_tiers  jsonb NOT NULL DEFAULT
    '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.035],[5000000,0.045],[10000000,0.055],[20000000,0.065],[null,0.075]]'::jsonb,

  -- PDF letterhead. Config rather than hard-coded so the firm's address /
  -- phone / HST number can be corrected without a code change.
  firm_name        text NOT NULL DEFAULT 'NAVA WILSON PROFESSIONAL CORPORATION',
  firm_subtitle    text NOT NULL DEFAULT 'Barristers and Solicitors',
  firm_address     text NOT NULL DEFAULT 'Suite 210, 10 Milner Business Court, Toronto, Ontario, M1B 3C6',
  firm_phone       text NOT NULL DEFAULT '416-321-1100',
  firm_fax         text NOT NULL DEFAULT '416-321-1107',
  firm_hst_number  text NOT NULL DEFAULT '829252303RT0001',

  is_active   boolean NOT NULL DEFAULT true,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Exactly one live config row (same idiom as deals_one_active_per_lead).
CREATE UNIQUE INDEX IF NOT EXISTS closing_cost_config_one_active_idx
  ON closing_cost_config (is_active)
  WHERE is_active = true AND is_deleted = false;

-- Seed the single row from the column defaults. Guarded so a re-run never
-- creates a second one (and never overwrites edited values).
INSERT INTO closing_cost_config (label)
SELECT 'Firm standard'
WHERE NOT EXISTS (
  SELECT 1 FROM closing_cost_config WHERE is_active = true AND is_deleted = false
);

-- ─────────────────────────────────────────────────────────────────────
-- deal_closing_estimates — per-deal estimate with frozen snapshots
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS deal_closing_estimates (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id   uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

  -- The only figures entered per file.
  purchase_price          numeric NOT NULL DEFAULT 0,
  deposit_paid            numeric NOT NULL DEFAULT 0,
  mortgage_amount         numeric NOT NULL DEFAULT 0,
  is_toronto              boolean NOT NULL DEFAULT false,
  is_first_time_buyer     boolean NOT NULL DEFAULT false,
  -- null = use the automatic §6.4 estimate; a value = the exact FCT quote.
  title_premium_override  numeric,
  file_no_display         text,

  -- FROZEN SNAPSHOTS, written on every save and never recomputed on read.
  --   rates_used  the EFFECTIVE rates (config + any per-file overrides) plus
  --               calc_version, so a historic estimate can always be explained.
  --   line_items  the rendered statement — groups → lines → hst → total →
  --               balance, amounts already rounded to cents.
  rates_used  jsonb NOT NULL DEFAULT '{}'::jsonb,
  line_items  jsonb NOT NULL DEFAULT '{}'::jsonb,

  total_closing_costs numeric NOT NULL DEFAULT 0,
  balance_due         numeric NOT NULL DEFAULT 0,

  -- draft  = staff-only working copy, invisible to the client.
  -- issued = sent to the client; the portal renders the latest issued row.
  status     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued')),
  issued_at  timestamptz,

  -- Vercel Blob URL of the generated one-page PDF. Deliberately NOT mirrored
  -- into lead_corporate_docs — that table drives the existing admin Documents
  -- modal and the portal Documents view, and an estimate is not a client
  -- document.
  pdf_url           text,
  pdf_generated_at  timestamptz,

  created_by_email  text,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_closing_estimates_deal_id_idx
  ON deal_closing_estimates (deal_id);

-- One working draft per deal, so the estimate PUT can upsert without racing.
-- Issued rows accumulate as history and are excluded here.
CREATE UNIQUE INDEX IF NOT EXISTS deal_closing_estimates_one_draft_idx
  ON deal_closing_estimates (deal_id)
  WHERE status = 'draft' AND is_deleted = false;

-- "Latest issued estimate for this deal" — the portal's read path.
CREATE INDEX IF NOT EXISTS deal_closing_estimates_issued_idx
  ON deal_closing_estimates (deal_id, issued_at DESC)
  WHERE status = 'issued' AND is_deleted = false;

-- ─────────────────────────────────────────────────────────────────────
-- Grants + RLS
-- ─────────────────────────────────────────────────────────────────────
-- Supabase's default privileges do NOT reach freshly-created tables, so even
-- the service_role client hits "permission denied for table". Grant explicitly
-- (mirrors 2026-07-08-create-brokers-and-coupons.sql).
GRANT ALL ON closing_cost_config    TO anon, authenticated, service_role;
GRANT ALL ON deal_closing_estimates TO anon, authenticated, service_role;

-- Enable RLS with NO policies so the grants above can't be used through the
-- public anon/authenticated keys. Both apps read these tables with the
-- service_role key, which BYPASSES RLS and keeps working.
ALTER TABLE closing_cost_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_closing_estimates ENABLE ROW LEVEL SECURITY;
