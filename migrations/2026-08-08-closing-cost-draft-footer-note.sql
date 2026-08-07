-- Closing-cost calculator: move the last piece of hard-coded boilerplate into
-- the statement-type config.
--
-- ── What this is ──────────────────────────────────────────────────────
--
-- The customer portal's estimate modal printed its own disclaimer paragraph,
-- separate from the one Settings → Closing costs owns. Most of it duplicated
-- `DISCLAIMERS` in the twin src/lib/closingCosts.ts, but ONE sentence existed
-- nowhere else — the limit on what the quoted fee actually covers:
--
--   "Assumes a standard residential purchase with no more than one mortgage,
--    no independent legal advice, no title-related rectification, and no gift
--    or trust arrangements; additional fees apply where these are needed."
--
-- Deleting the portal's inlined copy without this would have quietly dropped
-- that limitation, so it moves to where the requirements say boilerplate
-- belongs: `footer_note` on the DRAFT statement type, editable by staff.
--
-- ── Draft only, deliberately ──────────────────────────────────────────
--
-- A final account states the fees actually charged, so a caveat about which
-- fees the QUOTE assumed does not belong on it. The `final` row is untouched.
--
-- ── Why `= ''` and not an unconditional UPDATE ────────────────────────
--
-- `statementTypeFromRow` treats an empty footer note as a deliberate choice and
-- keeps it cleared. A firm that has already written its own note — or has
-- deliberately emptied one — must not have it overwritten by a migration.
-- Only a row that has never carried one is seeded.
--
-- Idempotent: safe to re-run. The second run matches nothing.

UPDATE closing_cost_statement_types
SET
  footer_note =
    'Assumes a standard residential purchase with no more than one mortgage, no independent legal advice, no title-related rectification, and no gift or trust arrangements; additional fees apply where these are needed.',
  updated_at = now()
WHERE type_key = 'draft'
  AND is_deleted = false
  AND COALESCE(footer_note, '') = '';
