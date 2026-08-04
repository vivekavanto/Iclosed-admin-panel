-- Closing-cost calculator: firm profiles + statement types.
--
-- Two client-facing choices are being added to the estimate flow:
--
--   FIRM            'navawilson' or 'iclosed'. iClosed is a DIVISION of Nava
--                   Wilson, so it shares the address, telephone, fax and HST
--                   number; only the name, the badge and the brand colour
--                   differ. Each firm does carry its own fee schedule.
--
--   STATEMENT TYPE  'draft' (an estimate) or 'final' (the account). Identical
--                   line items and identical maths — only the title, the
--                   on-screen heading, the leading disclaimer, an optional
--                   footer note and the watermark change.
--
-- ── THE SPLIT RULE (get this wrong and the numbers drift) ───────────────
--
-- src/lib/closingCosts.ts already computes:
--
--     taxableBase = legalFees + adminFee + teraview + sheriff
--
-- HST is charged on exactly those four because they are supplies made BY THE
-- FIRM. Land transfer tax, the FCT premium and the ServiceOntario e-reg tariff
-- are pass-throughs the firm does not supply, so they carry no HST. Hence:
--
--     charged HST → a firm charge        → PER-FIRM  (closing_cost_config)
--     no HST      → statutory/3rd-party  → SHARED    (closing_cost_shared_rates)
--
-- Shared values live in ONE row so a bracket change can never be applied to one
-- firm and forgotten on the other.
--
-- ── DEPLOY ORDER (this file is safe to run at any point) ────────────────
--
-- Two hazards shaped this migration, both silent failures rather than errors:
--
--  1. The build running in production reads the config with `.maybeSingle()`,
--     which ERRORS when two rows match — and the error handler falls back to
--     code defaults. A second ACTIVE firm row would therefore quietly switch
--     every live estimate to default rates. So iClosed is seeded INACTIVE and
--     is turned on from the settings page after the new build is live.
--
--  2. Dropping the legacy statutory columns has the same effect on the old
--     build. So they are NOT dropped here — that is a separate, later file
--     (2026-08-04-closing-cost-drop-legacy-statutory-columns.sql). Until then
--     they are stale but harmless: the app's merge always lets
--     closing_cost_shared_rates win.
--
-- Idempotent: safe to re-run. Every seed is guarded so a second run never
-- duplicates a row or overwrites an edited value.

-- ─────────────────────────────────────────────────────────────────────
-- 1. closing_cost_config becomes ONE ROW PER FIRM
-- ─────────────────────────────────────────────────────────────────────
-- The table keeps its name (a rename would be a hard cutover: old build + new
-- schema = the table is simply gone). Its meaning changes from "the firm's
-- standard rates" to "this firm's fees and letterhead".
ALTER TABLE closing_cost_config
  ADD COLUMN IF NOT EXISTS firm_key    text,
  -- The small chip rendered beside "Legal & Admin Fees" on the statement.
  ADD COLUMN IF NOT EXISTS firm_badge  text    NOT NULL DEFAULT '',
  -- Was hard-coded twice and inconsistently: #C10007 in the admin UI, #CE2028
  -- in the PDF. Now data, so each firm prints in its own colour.
  ADD COLUMN IF NOT EXISTS brand_color text    NOT NULL DEFAULT '#C10007',
  ADD COLUMN IF NOT EXISTS sort_order  integer NOT NULL DEFAULT 0;

-- Claim the incumbent row. Guarded on firm_key IS NULL so a re-run never
-- clobbers a label or colour that has since been edited.
UPDATE closing_cost_config
   SET firm_key    = 'navawilson',
       label       = 'Nava Wilson',
       firm_badge  = 'NAVA WILSON PC',
       brand_color = '#CE2028',
       sort_order  = 0
 WHERE firm_key IS NULL
   AND is_deleted = false;

-- A fresh environment where the 2026-07-30 seed INSERT never ran.
INSERT INTO closing_cost_config (firm_key, label, firm_badge, brand_color, sort_order)
SELECT 'navawilson', 'Nava Wilson', 'NAVA WILSON PC', '#CE2028', 0
WHERE NOT EXISTS (
  SELECT 1 FROM closing_cost_config WHERE firm_key = 'navawilson' AND is_deleted = false
);

-- Any soft-deleted straggler, so SET NOT NULL below cannot fail.
UPDATE closing_cost_config
   SET firm_key = 'legacy-' || left(id::text, 8)
 WHERE firm_key IS NULL;

ALTER TABLE closing_cost_config ALTER COLUMN firm_key SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Replace the singleton index (MUST run before the iClosed insert)
-- ─────────────────────────────────────────────────────────────────────
-- is_active is REPURPOSED, not removed. It used to mean "the one live config";
-- it now means "selectable when preparing an estimate", and more than one firm
-- may be active at once.
DROP INDEX IF EXISTS closing_cost_config_one_active_idx;

CREATE UNIQUE INDEX IF NOT EXISTS closing_cost_config_firm_key_idx
  ON closing_cost_config (firm_key)
  WHERE is_deleted = false;

-- ─────────────────────────────────────────────────────────────────────
-- 3. Seed iClosed — INACTIVE (see the deploy-order note above)
-- ─────────────────────────────────────────────────────────────────────
-- Copies Nava Wilson's fee schedule as a starting point, the statutory columns
-- only to satisfy their NOT NULL until the follow-up migration drops them, and
-- the letterhead in full — because iClosed is a division of the same firm and
-- genuinely shares that address, telephone, fax and HST number.
INSERT INTO closing_cost_config (
  firm_key, label, is_active, sort_order, brand_color, firm_badge,
  reg_transfer, reg_mortgage, teraview, sheriff,
  legal_transfer, legal_mortgage, legal_title_submission, admin_fee,
  hst_rate, rebate_ontario_max, rebate_toronto_max,
  title_premium_base, title_premium_rate, title_premium_min,
  ltt_tiers, mltt_tiers,
  firm_name, firm_subtitle, firm_address, firm_phone, firm_fax, firm_hst_number
)
SELECT
  'iclosed', 'iClosed', false, 1, '#C10007', 'ICLOSED',
  n.reg_transfer, n.reg_mortgage, n.teraview, n.sheriff,
  n.legal_transfer, n.legal_mortgage, n.legal_title_submission, n.admin_fee,
  n.hst_rate, n.rebate_ontario_max, n.rebate_toronto_max,
  n.title_premium_base, n.title_premium_rate, n.title_premium_min,
  n.ltt_tiers, n.mltt_tiers,
  'ICLOSED', n.firm_subtitle, n.firm_address, n.firm_phone, n.firm_fax, n.firm_hst_number
FROM closing_cost_config n
WHERE n.firm_key = 'navawilson'
  AND n.is_deleted = false
  AND NOT EXISTS (
    SELECT 1 FROM closing_cost_config WHERE firm_key = 'iclosed' AND is_deleted = false
  );

-- ─────────────────────────────────────────────────────────────────────
-- 4. closing_cost_shared_rates — statutory & third-party, one row
-- ─────────────────────────────────────────────────────────────────────
-- Column defaults mirror src/lib/closingCosts.ts DEFAULT_RATES exactly, which
-- is what tests/closingCostSettings.test.ts asserts.
CREATE TABLE IF NOT EXISTS closing_cost_shared_rates (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label  text NOT NULL DEFAULT 'Statutory & third-party (shared by all firms)',

  -- ServiceOntario e-registration tariff. Identical for every firm, no HST.
  -- reg_mortgage is only charged when a mortgage exists.
  reg_transfer  numeric NOT NULL DEFAULT 85,
  reg_mortgage  numeric NOT NULL DEFAULT 85,

  -- Statutory rates & caps.
  hst_rate            numeric NOT NULL DEFAULT 0.13,
  rebate_ontario_max  numeric NOT NULL DEFAULT 4000,
  rebate_toronto_max  numeric NOT NULL DEFAULT 4475,

  -- FCT title-insurance premium approximation (the insurer's rate, not the
  -- firm's charge):
  --   max(title_premium_min, title_premium_base + price * title_premium_rate)
  -- A per-file override on the estimate replaces this entirely.
  title_premium_base  numeric NOT NULL DEFAULT 250,
  title_premium_rate  numeric NOT NULL DEFAULT 0.000785,
  title_premium_min   numeric NOT NULL DEFAULT 300,

  -- Marginal land-transfer-tax brackets as [[cap, rate], ...]. JSON has no
  -- Infinity, so the FINAL tier's cap is null, meaning "and above".
  ltt_tiers   jsonb NOT NULL DEFAULT
    '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[null,0.025]]'::jsonb,
  mltt_tiers  jsonb NOT NULL DEFAULT
    '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.035],[5000000,0.045],[10000000,0.055],[20000000,0.065],[null,0.075]]'::jsonb,

  -- Used for every estimate until the per-deal firm / statement-type picker
  -- ships. Seeded to the incumbent so nothing existing changes.
  default_firm_key        text NOT NULL DEFAULT 'navawilson',
  default_statement_type  text NOT NULL DEFAULT 'draft',

  is_active   boolean NOT NULL DEFAULT true,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS closing_cost_shared_rates_one_active_idx
  ON closing_cost_shared_rates (is_active)
  WHERE is_active = true AND is_deleted = false;

-- Seed by COPYING the live values rather than relying on the column defaults —
-- someone may already have edited the HST rate or a bracket.
--
-- Wrapped in a DO block because this file must stay re-runnable after the
-- follow-up migration has dropped those legacy columns: referencing a dropped
-- column in plain SQL is a parse error, so the copy is built dynamically and
-- only when the columns still exist.
DO $$
DECLARE
  has_legacy boolean;
BEGIN
  IF EXISTS (
    SELECT 1 FROM closing_cost_shared_rates WHERE is_active = true AND is_deleted = false
  ) THEN
    RETURN;  -- already seeded; never overwrite edited values
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'closing_cost_config'
       AND column_name  = 'hst_rate'
  ) INTO has_legacy;

  IF has_legacy THEN
    EXECUTE $q$
      INSERT INTO closing_cost_shared_rates (
        reg_transfer, reg_mortgage, hst_rate, rebate_ontario_max, rebate_toronto_max,
        title_premium_base, title_premium_rate, title_premium_min, ltt_tiers, mltt_tiers
      )
      SELECT
        reg_transfer, reg_mortgage, hst_rate, rebate_ontario_max, rebate_toronto_max,
        title_premium_base, title_premium_rate, title_premium_min, ltt_tiers, mltt_tiers
      FROM closing_cost_config
      WHERE firm_key = 'navawilson' AND is_deleted = false
      LIMIT 1
    $q$;
  END IF;

  -- Nothing to copy from (fresh database, or the columns are already dropped).
  IF NOT EXISTS (
    SELECT 1 FROM closing_cost_shared_rates WHERE is_active = true AND is_deleted = false
  ) THEN
    INSERT INTO closing_cost_shared_rates DEFAULT VALUES;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- 5. closing_cost_statement_types — the client-facing wording
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS closing_cost_statement_types (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_key  text NOT NULL,          -- 'draft' | 'final'
  label     text NOT NULL,          -- staff-facing tab label

  title             text NOT NULL,  -- heading printed on the PDF
  screen_heading    text NOT NULL,  -- heading shown above the on-screen statement
  disclaimer_intro  text NOT NULL,  -- the bolded lead line
  footer_note       text NOT NULL DEFAULT '',

  show_watermark  boolean NOT NULL DEFAULT false,
  watermark_text  text    NOT NULL DEFAULT 'DRAFT',

  sort_order  integer NOT NULL DEFAULT 0,
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS closing_cost_statement_types_key_idx
  ON closing_cost_statement_types (type_key)
  WHERE is_deleted = false;

-- The 'draft' seed is BYTE-IDENTICAL to the strings previously hard-coded in
-- closingCostPdf.ts and ClosingCostStatement.tsx, so nothing a client sees moves
-- until a staff member deliberately edits it.
--
-- Only the lead line is configurable; the remaining disclaimer paragraphs stay
-- in src/lib/closingCosts.ts, which is a twin file shared with the customer
-- portal and must keep one source of truth.
INSERT INTO closing_cost_statement_types (
  type_key, label, title, screen_heading, disclaimer_intro,
  show_watermark, watermark_text, sort_order
)
SELECT
  'draft',
  'Draft estimate',
  'ESTIMATED CLOSING COSTS — RESIDENTIAL PURCHASE (ONTARIO)',
  'ESTIMATED STATEMENT OF ACCOUNT',
  'This is an estimate for planning purposes only. Final figures will be set out in the Statement of Account before closing.',
  true,
  'DRAFT',
  0
WHERE NOT EXISTS (
  SELECT 1 FROM closing_cost_statement_types WHERE type_key = 'draft' AND is_deleted = false
);

-- Placeholder wording — have it approved before issuing a final account.
INSERT INTO closing_cost_statement_types (
  type_key, label, title, screen_heading, disclaimer_intro,
  show_watermark, watermark_text, sort_order
)
SELECT
  'final',
  'Final account',
  'STATEMENT OF ACCOUNT — RESIDENTIAL PURCHASE (ONTARIO)',
  'STATEMENT OF ACCOUNT',
  'Figures are final subject to the Statement of Adjustments settled on closing.',
  false,
  'DRAFT',
  1
WHERE NOT EXISTS (
  SELECT 1 FROM closing_cost_statement_types WHERE type_key = 'final' AND is_deleted = false
);

-- ─────────────────────────────────────────────────────────────────────
-- 6. Forward hooks on deal_closing_estimates
-- ─────────────────────────────────────────────────────────────────────
-- Added now so the per-deal firm / statement-type picker needs no second
-- migration. Nothing reads them yet.
--
-- statement_type is the CLIENT-FACING document flavour ('draft' | 'final').
-- It is NOT `status`, which is the WORKFLOW state ('draft' | 'issued') — an
-- issued estimate can perfectly well be a draft statement.
--
-- Both are nullable with NO default and NO check constraint: firms and
-- statement types are rows in tables now, not enums, so a check would have to
-- be migrated every time one is added.
ALTER TABLE deal_closing_estimates
  ADD COLUMN IF NOT EXISTS firm_key       text,
  ADD COLUMN IF NOT EXISTS statement_type text;

-- Every estimate written before firms existed carried the Nava Wilson
-- letterhead — a fact, so it is safe to backfill.
UPDATE deal_closing_estimates
   SET firm_key = 'navawilson'
 WHERE firm_key IS NULL;

-- statement_type is deliberately LEFT NULL. Mapping the workflow status onto a
-- client-facing flavour would be a guess. The reader resolves it as
--   statement_type ?? (status = 'issued' ? 'final' : 'draft')
-- which reproduces today's watermark behaviour exactly.

-- No index on firm_key: cardinality 2, and every lookup already goes through
-- deal_closing_estimates_deal_id_idx.

-- ─────────────────────────────────────────────────────────────────────
-- 7. Grants + RLS
-- ─────────────────────────────────────────────────────────────────────
-- Supabase's default privileges do NOT reach freshly-created tables, so even
-- the service_role client hits "permission denied for table". Grant explicitly
-- (mirrors 2026-07-08-create-brokers-and-coupons.sql).
GRANT ALL ON closing_cost_shared_rates    TO anon, authenticated, service_role;
GRANT ALL ON closing_cost_statement_types TO anon, authenticated, service_role;

-- Enable RLS with NO policies so the grants above can't be used through the
-- public anon/authenticated keys. Both tables are read with the service_role
-- key, which BYPASSES RLS and keeps working.
ALTER TABLE closing_cost_shared_rates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE closing_cost_statement_types ENABLE ROW LEVEL SECURITY;
