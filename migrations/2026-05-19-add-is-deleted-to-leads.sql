-- Soft-delete flag on leads. Admin's Delete button used to attempt a hard
-- DELETE which failed on FK constraints (retainer_signatures, deals, etc.)
-- and risked silent destruction of converted clients' history. We now mark
-- leads as is_deleted=true and filter them out of every list query; the
-- underlying retainer signatures, deals, and signed PDFs stay intact so the
-- delete is reversible by toggling the flag back to false.
--
-- Idempotent: safe to re-run.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index so the GET /api/admin/leads filter stays fast on large
-- tables — most rows have is_deleted=false so the partial form is much
-- smaller than indexing the whole column.
CREATE INDEX IF NOT EXISTS leads_active_idx
  ON leads (created_at DESC)
  WHERE is_deleted = FALSE;
