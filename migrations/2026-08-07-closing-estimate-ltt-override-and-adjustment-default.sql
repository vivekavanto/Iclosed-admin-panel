-- Closing-cost calculator: per-file land transfer tax overrides, and a
-- configurable starting figure for the Statement of Adjustments item.
--
-- ── 1. LTT overrides on deal_closing_estimates ─────────────────────────
--
-- The bracket tables in closing_cost_shared_rates encode a STANDARD residential
-- purchase. Staff had no way out when a file isn't one — a partial interest, an
-- assumed-mortgage consideration, a ministry reassessment — short of editing the
-- brackets every other file is priced from.
--
-- These two columns hold a dollar figure that replaces the calculation for one
-- file. NULL means "use the brackets", which is what every existing row is, so
-- nothing already saved changes. An explicit 0 is a real override (an exempt
-- transfer) and is deliberately distinguishable from NULL.
--
-- The first-time-buyer rebates cap against the overridden figure, since the
-- rebate refunds the tax actually payable. src/lib/closingCosts.ts CALC_VERSION
-- is bumped 4 → 5; the change is additive, so a v5 statement with no override
-- is identical to a v4 one.
--
-- ── 2. property_tax_default on closing_cost_shared_rates ───────────────
--
-- The property tax & common expense adjustment a NEW estimate starts with. It
-- is a planning figure, not a fee: it carries no HST, stays out of "Total
-- closing costs", and is added to the client's balance on its own line.
--
-- In the shared row rather than hard-coded in the calculator so the firm can
-- change its planning figure from Settings → Closing costs without a deploy.
--
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Per-file land transfer tax overrides
-- ─────────────────────────────────────────────────────────────────────
-- Nullable with NO default: NULL is meaningful here ("use the brackets"), so a
-- default would erase the distinction the calculator depends on.
ALTER TABLE deal_closing_estimates
  ADD COLUMN IF NOT EXISTS provincial_ltt_override numeric,
  ADD COLUMN IF NOT EXISTS municipal_ltt_override  numeric;

-- ─────────────────────────────────────────────────────────────────────
-- 2. The Statement of Adjustments starting figure
-- ─────────────────────────────────────────────────────────────────────
-- Mirrors DEFAULT_PROPERTY_TAX_ADJUSTMENT in src/lib/closingCostSettings.ts.
ALTER TABLE closing_cost_shared_rates
  ADD COLUMN IF NOT EXISTS property_tax_default numeric NOT NULL DEFAULT 1000;

-- Nothing to backfill: the column default applies to the single existing row,
-- and the calculator treats it as a starting value for NEW estimates only —
-- estimates already saved keep whatever figure was entered on them.
