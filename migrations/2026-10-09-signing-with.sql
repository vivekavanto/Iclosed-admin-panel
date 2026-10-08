-- "Signing with": whose calendar a client sees when booking their signing
-- appointment.
--
-- This is deliberately NOT the file's lawyer. The person signing is not always
-- the lawyer, and the signing calendar owner may not be a lawyer at all, so it
-- is its own admin-only field and is never shown to the client.
--
--   signing_settings.default_signing_with  initials of the calendar used for
--                                           every file that has no override.
--   deals.signing_with                      per-file override (initials).
--                                           NULL = use the default above.
--
-- Both hold signing_lawyers.initials (the bookable calendar list, managed under
-- Settings > Signing). Stored as text rather than a foreign key so renaming or
-- deactivating a calendar never blocks editing a file; the reader falls back to
-- the default when the stored initials no longer match an active calendar.
--
-- signing_appointments.side records which side of a Purchase & Sale file an
-- appointment is for, so the client portal can enforce one booking per
-- property (deal + side) rather than one per file.
--
-- Idempotent: safe to re-run.

BEGIN;

ALTER TABLE signing_settings
  ADD COLUMN IF NOT EXISTS default_signing_with text;

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS signing_with text;

ALTER TABLE signing_appointments
  ADD COLUMN IF NOT EXISTS side text
  CHECK (side IS NULL OR side IN ('purchase', 'sale'));

CREATE INDEX IF NOT EXISTS signing_appointments_deal_side_idx
  ON signing_appointments (deal_id, side)
  WHERE status = 'confirmed';

COMMIT;

-- Verification. All three must return a row.
SELECT column_name FROM information_schema.columns
WHERE table_name = 'signing_settings' AND column_name = 'default_signing_with';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'deals' AND column_name = 'signing_with';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'signing_appointments' AND column_name = 'side';
