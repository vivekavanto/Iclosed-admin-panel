-- Backfill: link signing bookings that were saved with deal_id NULL.
--
-- Before linkAppointmentToDeal (2026-10-14) a booking made from the public
-- booking link — typed file number, client not signed in — was stored with no
-- deal_id, so it never showed in the All Files "Signing" column. The new code
-- only links bookings made from now on; this applies the same rule to the old
-- ones: the file number must match a live deal AND the booking email must be the
-- email of that deal's lead, so a mistyped file number can't attach a booking to
-- someone else's file. Rows that don't match stay unlinked.
--
-- Safe to re-run: it only touches rows whose deal_id is still NULL.

-- Preview what will be linked (run this first):
-- SELECT sa.id, sa.file_number, sa.client_email, sa.status, sa.start_at, d.id AS deal_id
-- FROM signing_appointments sa
-- JOIN deals d ON lower(trim(d.file_number)) = lower(trim(sa.file_number))
--             AND d.is_deleted = false
-- JOIN leads l ON l.id = d.lead_id
--             AND lower(trim(l.email)) = lower(trim(sa.client_email))
-- WHERE sa.deal_id IS NULL
--   AND sa.file_number IS NOT NULL;

UPDATE signing_appointments sa
SET deal_id = d.id,
    lead_id = d.lead_id
FROM deals d
JOIN leads l ON l.id = d.lead_id
WHERE sa.deal_id IS NULL
  AND sa.file_number IS NOT NULL
  AND d.is_deleted = false
  AND lower(trim(d.file_number)) = lower(trim(sa.file_number))
  AND lower(trim(l.email)) = lower(trim(sa.client_email));
