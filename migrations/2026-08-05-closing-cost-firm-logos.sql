-- Per-firm letterhead logo for the closing-cost statement.
--
-- Each firm gets its own image, uploaded from Settings → Closing Costs → Firms
-- and printed at the head of the PDF in place of the firm-name wordmark.
--
-- ── Why a URL and not the bytes ─────────────────────────────────────────
-- The image lives in Vercel Blob like every other upload in this app, and only
-- its URL is stored here. Putting binary in Postgres would bloat every read of
-- a table the calculator touches on each estimate, for a file that changes
-- perhaps twice a year.
--
-- ── Format constraint ───────────────────────────────────────────────────
-- pdf-lib can embed PNG and JPEG only — no SVG, no WebP. The upload route
-- enforces that, because a logo that cannot be embedded would silently drop off
-- the statement. The PDF falls back to the firm-name text whenever the logo is
-- absent or unreadable, so a broken link never yields a blank letterhead.
--
-- Nullable with no default: "no logo" is the correct state for a firm that has
-- not supplied one, and the text wordmark is a perfectly good letterhead.
--
-- Idempotent: safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'closing_cost_config'
       AND column_name  = 'firm_key'
  ) THEN
    RAISE EXCEPTION
      'closing_cost_config.firm_key does not exist — run 2026-08-03-closing-cost-firms-and-statement-types.sql first';
  END IF;
END $$;

ALTER TABLE closing_cost_config
  ADD COLUMN IF NOT EXISTS logo_url text;

-- Verify:
--   SELECT firm_key, label, logo_url FROM closing_cost_config
--    WHERE is_deleted = false ORDER BY sort_order;
