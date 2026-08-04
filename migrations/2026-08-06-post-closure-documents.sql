-- Post-closure documents: record when a stored document was emailed out.
--
-- The final reporting package is uploaded after closing and then sent to the
-- client(s). Sending it is outward-facing, so the row itself carries a trace —
-- that is what lets the admin UI show "Sent 2026-08-06 to john@…" instead of
-- leaving staff to guess whether it already went, and re-sending a closing
-- package to a client is exactly the kind of thing that should be visible.
--
-- Deliberately on `lead_corporate_docs` rather than a new table: the final
-- report IS a client document. Reusing this table means it appears in the admin
-- Documents modal and the customer portal's Documents page for free, so the
-- client can re-download it later instead of hunting for the email.
--
-- The columns are generic on purpose. Nothing here is specific to the final
-- report, and any other document type can adopt the same "email this out"
-- affordance without another migration.
--
-- Idempotent: safe to re-run.

ALTER TABLE lead_corporate_docs
  ADD COLUMN IF NOT EXISTS emailed_at timestamptz,
  -- Comma-separated when a package went to several co-purchasers at once.
  ADD COLUMN IF NOT EXISTS emailed_to text;

-- No backfill: NULL correctly means "never sent from the app". A document that
-- was emailed by hand before this existed genuinely has no record here, and
-- inventing one would be worse than showing nothing.

-- ─────────────────────────────────────────────────────────────────────
-- Allow the new doc_type
-- ─────────────────────────────────────────────────────────────────────
-- `lead_corporate_docs.doc_type` carries a CHECK constraint that predates this
-- repo's migrations folder (it was created directly in Supabase), so uploading
-- a final report fails with:
--
--   new row for relation "lead_corporate_docs" violates check constraint
--   "lead_corporate_docs_doc_type_check"
--
-- The constraint has to be recreated to include 'final_report'. Since its
-- current definition is not in version control, the replacement is built from
-- the values that ACTUALLY EXIST in the table, unioned with the ones the code
-- writes. That way the new constraint can never reject a row that is already
-- stored — recreating it from a hard-coded list would risk exactly that.
DO $$
DECLARE
  allowed text;
BEGIN
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO allowed
    FROM (
      -- Everything already stored, so no existing row is invalidated.
      SELECT DISTINCT doc_type AS v
        FROM lead_corporate_docs
       WHERE doc_type IS NOT NULL
      UNION
      -- Everything the application writes today.
      SELECT unnest(ARRAY[
        'aps',
        'home_insurance',
        'identification',
        'retainer_agreement',
        'final_report'
      ])
    ) s;

  ALTER TABLE lead_corporate_docs
    DROP CONSTRAINT IF EXISTS lead_corporate_docs_doc_type_check;

  EXECUTE format(
    'ALTER TABLE lead_corporate_docs ADD CONSTRAINT lead_corporate_docs_doc_type_check '
    'CHECK (doc_type IS NULL OR doc_type IN (%s))',
    allowed
  );
END $$;

-- Verify:
--   SELECT doc_type, file_name, emailed_at, emailed_to
--     FROM lead_corporate_docs
--    WHERE doc_type = 'final_report'
--    ORDER BY created_at DESC;
--
--   -- the rebuilt constraint
--   SELECT pg_get_constraintdef(oid)
--     FROM pg_constraint
--    WHERE conname = 'lead_corporate_docs_doc_type_check';
