-- A free-text comment per partner, shown as its own column on Partners & Codes.
-- Idempotent: safe to re-run.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS comment text;
