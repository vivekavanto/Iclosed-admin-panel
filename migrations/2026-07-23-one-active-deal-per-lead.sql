-- GAP-002 — prevent two concurrent lead conversions from creating duplicate
-- deals for the same lead. convertLead() checks "does a deal already exist?"
-- then inserts, which is racy: two simultaneous calls both see none and both
-- insert. This partial unique index makes the DB reject the second insert; the
-- loser is turned into a clean 409 in convertLead (error code 23505).
--
-- Invariant: a lead has at most ONE active (non-deleted) deal. Co-purchasers /
-- co-sellers are SEPARATE lead rows with their own deal, so this does not affect
-- family files. A soft-deleted deal (is_deleted = true) is excluded, so a lead
-- can be re-converted after its deal is deleted.
--
-- ⚠️ If this fails with "could not create unique index", existing data already
-- has a lead with >1 active deal (from a past race) — de-dup those first, then
-- re-run.

CREATE UNIQUE INDEX IF NOT EXISTS deals_one_active_per_lead
  ON deals (lead_id)
  WHERE is_deleted = false;
