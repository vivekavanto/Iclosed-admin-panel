-- 2026-09-11 — Backfill all existing leads to firm_key = 'iclosed'
--
-- Business decision: re-brand all existing files from Nava Wilson to iClosed LLP.
-- This updates all leads (and their co-leads) to the new default firm.
--
-- This is intentional and irreversible — all client-visible branding (email sender,
-- retainer lockup, statement letterhead) will shift to iClosed for all files.
--
-- Pieces:
--   1. Update all leads (primary and co-leads) from 'navawilson' to 'iclosed'
--   2. Verify the change (comment out the verification queries or run manually)

BEGIN;

-- Update all leads to iclosed
UPDATE public.leads
SET firm_key = 'iclosed'
WHERE firm_key = 'navawilson';

-- Note: deals inherit firm_key from their linked lead (via leads.firm_key),
-- so they do NOT need a separate update. The firm is read from the lead at
-- runtime (see leadFirm.ts: resolveLeadFirm reads from the root lead).

COMMIT;

-- Verification queries (run manually after commit):
-- SELECT firm_key, count(*) FROM leads GROUP BY firm_key ORDER BY firm_key;
-- Expected: all leads now have 'iclosed', none have 'navawilson'
--
-- SELECT id, first_name, last_name, firm_key FROM leads
--   WHERE parent_lead_id IS NULL ORDER BY created_at DESC LIMIT 5;
-- Expected: newest files show firm_key = 'iclosed'
