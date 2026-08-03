-- Backfill leads.co_person_role for co-people created before the intake form
-- started recording which stack they were entered under.
--
-- Why it matters: co_person_role is THE authoritative purchaser/seller signal
-- for a co-person on a Purchase & Sale file. Without it the two are
-- indistinguishable — intake copies the parent's combined lead_type AND both
-- the purchase and selling addresses onto every co-person, and convertLead
-- seeds every family deal with both sides' milestones and tasks. So a NULL role
-- silently degrades anything that scopes by side: milestone emails (the bug
-- this was found through — purchase-side "Title Search" / "Mortgage
-- Instructions" emails reaching co-sellers), retainer sides, task seeding.
--
-- Recovery source: the PARENT lead's `co_persons` JSON array. Intake writes the
-- whole array to the parent at submission, and newer submissions include a
-- "role" key per entry. We match array entry -> child lead by email, which is
-- unique per co-person on a file.
--
-- Only fills rows that are currently NULL, and only from an entry whose role is
-- explicitly 'purchaser' or 'seller' — never guesses. Co-people whose parent
-- array predates the role key are left NULL and reported by the verification
-- query at the bottom; there is genuinely no signal left for those, so they
-- must be set by hand (or ignored, if they are test records).
--
-- Idempotent: safe to re-run.

BEGIN;

UPDATE leads AS child
SET co_person_role = entry.role
FROM leads AS parent,
     LATERAL jsonb_array_elements(parent.co_persons::jsonb) AS elem,
     LATERAL (
       SELECT lower(trim(elem ->> 'role'))  AS role,
              lower(trim(elem ->> 'email')) AS email
     ) AS entry
WHERE child.parent_lead_id = parent.id
  AND child.co_person_role IS NULL
  AND parent.co_persons IS NOT NULL
  AND jsonb_typeof(parent.co_persons::jsonb) = 'array'
  AND entry.role IN ('purchaser', 'seller')
  AND entry.email IS NOT NULL
  AND entry.email <> ''
  AND lower(trim(child.email)) = entry.email;

COMMIT;

-- Verification: what's left, and on which files. Anything listed here has no
-- role recoverable from data — set it manually, e.g.
--   UPDATE leads SET co_person_role = 'seller' WHERE id = '<lead id>';
SELECT d.file_number,
       d.type                                            AS deal_type,
       l.id                                              AS lead_id,
       trim(l.first_name || ' ' || coalesce(l.last_name, '')) AS name,
       l.email
FROM leads l
JOIN deals d ON d.lead_id = l.id AND d.is_deleted = false
WHERE l.parent_lead_id IS NOT NULL
  AND l.co_person_role IS NULL
  AND coalesce(l.is_deleted, false) = false
ORDER BY (d.type = 'Purchase & Sale') DESC, d.file_number;

