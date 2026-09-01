-- Label each file as a Nava Wilson file or an iClosed LLP file.
-- ---------------------------------------------------------------------------
-- iClosed serves clients under two entities. This column records which one a
-- file belongs to, and it drives three client-visible things in the app:
--
--   • the address every automated email is sent FROM / replied to
--   • the brand lockup at the foot of every email
--   • the retainer agreement's logo and its wording (rendered by the PORTAL,
--     which reads this same column out of this same database)
--
-- ── WHY THE DEFAULT IS 'navawilson' ────────────────────────────────────────
-- It is what every file already WAS. The shipped email lockup is the
-- "iClosed — POWERED BY NAVA WILSON" artwork and the retainer already named
-- Nava Wilson PC, so defaulting anywhere else would silently re-brand every
-- live file the moment the code deployed. New intake leads land here too: the
-- intake URL is still shared between the firms.
--
-- ── WHY IT LIVES ON leads AND NOT ON deals ─────────────────────────────────
-- A family file is several `leads` rows (co-purchasers / co-sellers hang off
-- the root by parent_lead_id) and one `deals` row per lead. The firm is a
-- property of the FILE, not of a deal or a person, and the surfaces that need
-- it — the retainer, the auth/welcome emails — run at lead level, before a
-- deal necessarily exists. So: leads.
--
-- The ROOT lead is authoritative (src/lib/leadFirm.ts resolves through
-- parent_lead_id, the same shape as upload_mode). The column is nonetheless
-- kept in step on every row in the family by the admin PUT handler, so a
-- direct SQL read of any single row still tells the truth.
--
-- ── DEPLOY ORDER ───────────────────────────────────────────────────────────
-- Safe to run BEFORE the code that reads it: the old build simply ignores an
-- unknown column, and the new build treats a missing column / null value as
-- 'navawilson'. Run it before deploying, not after, so the first send after
-- the deploy already has a value to read.
--
-- Idempotent: safe to re-run.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS firm_key text NOT NULL DEFAULT 'navawilson';

-- Belt and braces for rows that predate the DEFAULT (there should be none —
-- ADD COLUMN ... DEFAULT backfills — but a column added by hand earlier, or one
-- re-added after a drop, can leave blanks behind).
UPDATE leads
   SET firm_key = 'navawilson'
 WHERE firm_key IS NULL
    OR btrim(firm_key) = '';

-- Only the two known firms. A typo here would not throw anywhere in the app —
-- resolveFirmKey() falls back to Nava Wilson for an unrecognised value — so the
-- file would quietly keep the wrong branding. Fail at the write instead.
--
-- Keys match closing_cost_config.firm_key so a file's email branding and its
-- closing-cost letterhead can be reconciled without a mapping table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_firm_key_check'
  ) THEN
    ALTER TABLE leads
      ADD CONSTRAINT leads_firm_key_check
      CHECK (firm_key IN ('navawilson', 'iclosed'));
  END IF;
END $$;

-- The lists filter by firm; every family read also fans out over parent_lead_id.
CREATE INDEX IF NOT EXISTS leads_firm_key_idx ON leads (firm_key);

-- Verify — every existing file should come back as navawilson, none null:
--   SELECT firm_key, count(*) FROM leads GROUP BY firm_key ORDER BY firm_key;
--
-- And no family should be split across firms once admins start toggling
-- (the PUT handler writes the whole family; this finds any that drifted):
--   SELECT coalesce(parent_lead_id, id) AS root, count(DISTINCT firm_key)
--     FROM leads WHERE is_deleted = false
--    GROUP BY 1 HAVING count(DISTINCT firm_key) > 1;
