-- 2026-06-08-share-file-number-within-family.sql
--
-- All parties to one transaction (primary + co-purchasers + co-sellers) should
-- carry ONE file number. Previously each party was a separate deal that ran the
-- file-number counter independently, so they got different numbers
-- (primary 26P-0367, co-purchaser 26P-0366). This migration makes co-clients
-- share the primary's number, while keeping numbers unique ACROSS files.
--
-- Mechanism: a co-client deal may now duplicate its primary's file_number, so
-- the old global UNIQUE index is replaced with a PARTIAL unique index that only
-- constrains PRIMARY deals (is_primary_file = true). Primaries stay globally
-- unique; co-clients are free to repeat the family number.
--
-- ORDER MATTERS: the old global unique index must be dropped BEFORE the
-- co-client backfill, otherwise setting a co-client's number to its primary's
-- duplicates the value and the still-present unique index rejects it.
--
-- NOTE: both the admin app and the customer portal write to this shared DB.
-- is_primary_file has DEFAULT true so existing inserts in either app keep
-- working; the application code sets it explicitly (false for co-clients).

BEGIN;

-- ── 1. Flag column ─────────────────────────────────────────────────────────
ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS is_primary_file boolean NOT NULL DEFAULT true;

-- Backfill from lead parentage: a co-client's lead has parent_lead_id set.
UPDATE public.deals d
SET is_primary_file = (l.parent_lead_id IS NULL)
FROM public.leads l
WHERE d.lead_id = l.id;

-- ── 2. Drop the global unique rule FIRST ───────────────────────────────────
-- Co-clients are about to duplicate their primary's number, which the global
-- uniqueness would forbid. deals_file_number_key exists as a UNIQUE CONSTRAINT
-- (its backing index can't be dropped directly), so drop the constraint —
-- which also removes the index. The DROP INDEX is a fallback in case some
-- environment created it as a plain index instead.
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_file_number_key;
DROP INDEX IF EXISTS deals_file_number_key;

-- ── 3. Backfill existing co-client deals to their primary's number ─────────
-- Fixes already-diverged files (e.g. the co-purchaser showing 26P-0366).
-- Only updates co-clients whose primary deal exists.
UPDATE public.deals d
SET file_number = pd.file_number
FROM public.leads l
JOIN public.deals pd ON pd.lead_id = l.parent_lead_id
WHERE d.lead_id = l.id
  AND l.parent_lead_id IS NOT NULL
  AND d.file_number IS DISTINCT FROM pd.file_number;

-- ── 4. Add the primary-only partial unique index ───────────────────────────
-- Primaries were globally unique under the old index and the backfill only
-- changed co-client numbers, so primaries are still unique here.
CREATE UNIQUE INDEX IF NOT EXISTS deals_primary_file_number_key
  ON public.deals (file_number)
  WHERE is_primary_file;

-- Non-unique index so co-client lookups by file_number stay fast (the old
-- unique index also served this purpose).
CREATE INDEX IF NOT EXISTS deals_file_number_idx
  ON public.deals (file_number);

COMMIT;
