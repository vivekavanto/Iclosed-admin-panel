-- Closing-cost calculator: freeze the BRANDING and the WORDING onto every
-- estimate, alongside the rates that were already frozen.
--
-- ── The promise this keeps ─────────────────────────────────────────────
--
-- Settings → Closing costs tells staff, on the screen itself:
--
--   "Changing these affects new estimates only — an estimate already issued
--    keeps the figures the client was sent."
--
-- That was only half true. `rates_used` and `line_items` were frozen on every
-- save, so the FIGURES were safe. But the letterhead (firm name, address,
-- telephone, fax, HST number, logo, brand colour) and the statement wording
-- (PDF title, disclaimer lead line, footer note, watermark) were read LIVE at
-- render time. So editing the disclaimer today silently rewrote the disclaimer
-- on a statement issued last month, the moment anyone re-downloaded it.
--
-- `config_snapshot` closes that: it holds the resolved presentation values the
-- document was actually produced from, so a re-render reproduces the document
-- the client received rather than today's version of it.
--
-- ── config_version ────────────────────────────────────────────────────
--
-- A short digest of the configuration behind the document — the calculation
-- version, the effective rates and the resolved presentation — stamped on the
-- PDF next to the date it was prepared. Two statements carrying the same stamp
-- were produced from the same configuration; two carrying different stamps were
-- not, and the snapshots say how they differ.
--
-- ── Existing rows ─────────────────────────────────────────────────────
--
-- Deliberately NOT backfilled. A backfill would have to invent which
-- letterhead an old estimate was printed with, and inventing it is exactly the
-- failure this column exists to prevent. NULL means "no snapshot was taken",
-- and the render path treats that honestly: it falls back to the live config,
-- which is what those rows have always rendered from.
--
-- Idempotent: safe to re-run.

ALTER TABLE deal_closing_estimates
  ADD COLUMN IF NOT EXISTS config_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS config_version  text;

COMMENT ON COLUMN deal_closing_estimates.config_snapshot IS
  'Frozen presentation config: { firm: {...letterhead, brand, logo}, statement_type: {...wording, watermark} }. Rendered from instead of the live config so an issued document never changes. NULL on rows written before 2026-08-08.';

COMMENT ON COLUMN deal_closing_estimates.config_version IS
  'Short digest of calc version + effective rates + config_snapshot, e.g. "v5.9f3a2c1b". Stamped on the PDF.';
