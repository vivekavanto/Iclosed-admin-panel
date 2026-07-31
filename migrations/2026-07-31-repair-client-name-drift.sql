-- Repair leads → clients name drift.
--
-- Renaming a client writes `leads.first_name/last_name` and then mirrors the
-- same values onto the linked `public.clients` row (the record the customer
-- portal and milestone emails read). Neither DB trigger covers names:
--
--   * sync_lead_to_clients        — AFTER INSERT only, and ON CONFLICT DO
--                                   NOTHING, so it never updates an existing row
--   * sync_lead_personal_to_clients — AFTER UPDATE, but its column list is
--                                   marital_status / citizenship_status /
--                                   occupation / employer_phone / corporate_*
--                                   — no first_name or last_name
--
-- so the mirror lives purely in application code (PUT /api/admin/leads). When
-- that leg failed the request used to return 500 *after* the leads row had
-- already been renamed, leaving the two tables permanently disagreeing: the
-- admin panel (which reads leads) showed the new name while the client portal
-- (which reads clients) kept the old one.
--
-- This backfills the clients side from leads for every row still out of sync.
--
-- Direction: leads → clients. `leads` is what an admin edits, so it is the
-- newer value; clients is the stale mirror.
--
-- Idempotent: the WHERE clause only matches rows that actually differ, so
-- re-running it is a no-op.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Preview — run this FIRST and eyeball the rows before step 2.
-- ─────────────────────────────────────────────────────────────────────
-- SELECT c.id           AS client_id,
--        c.email,
--        c.first_name   AS client_first, l.first_name AS lead_first,
--        c.last_name    AS client_last,  l.last_name  AS lead_last
-- FROM public.clients c
-- JOIN public.leads   l ON l.client_id = c.id
-- WHERE COALESCE(l.is_deleted, false) = false
--   AND (c.first_name IS DISTINCT FROM l.first_name
--     OR c.last_name  IS DISTINCT FROM l.last_name)
-- ORDER BY c.email;

-- ─────────────────────────────────────────────────────────────────────
-- 2. Repair.
-- ─────────────────────────────────────────────────────────────────────
-- Joined on clients.id = leads.client_id (the explicit link) rather than on
-- email, so a shared/duplicated email can never pull a name across two
-- different people. Co-purchasers and co-sellers have their own leads rows and
-- their own clients rows, so each is repaired independently.
--
-- Soft-deleted leads are excluded — a deleted lead's name must not overwrite a
-- live customer record.
--
-- first_name / last_name are NOT NULL on clients, so blanks are coerced to ''
-- rather than nulled.
UPDATE public.clients c
SET first_name = COALESCE(l.first_name, ''),
    last_name  = COALESCE(l.last_name, ''),
    updated_at = now()
FROM public.leads l
WHERE l.client_id = c.id
  AND COALESCE(l.is_deleted, false) = false
  AND (c.first_name IS DISTINCT FROM COALESCE(l.first_name, '')
    OR c.last_name  IS DISTINCT FROM COALESCE(l.last_name, ''));

-- ─────────────────────────────────────────────────────────────────────
-- 3. Verify — should return zero rows.
-- ─────────────────────────────────────────────────────────────────────
-- SELECT count(*) AS still_drifted
-- FROM public.clients c
-- JOIN public.leads   l ON l.client_id = c.id
-- WHERE COALESCE(l.is_deleted, false) = false
--   AND (c.first_name IS DISTINCT FROM COALESCE(l.first_name, '')
--     OR c.last_name  IS DISTINCT FROM COALESCE(l.last_name, ''));

-- ─────────────────────────────────────────────────────────────────────
-- 4. Leads with NO customer record at all (informational).
-- ─────────────────────────────────────────────────────────────────────
-- These predate the 2026-06-03 clients registry. A rename saves on the file but
-- has nowhere to mirror to, so the portal keeps showing the old details. The
-- leads PUT route now returns an explicit warning for these instead of failing
-- silently. Deliberately NOT auto-created here — a clients row drives portal
-- login resolution and merge behaviour, so creating one is a decision, not a
-- side effect of a repair script.
--
-- SELECT l.id, l.email, l.first_name, l.last_name
-- FROM public.leads l
-- WHERE COALESCE(l.is_deleted, false) = false
--   AND l.client_id IS NULL
--   AND NOT EXISTS (
--     SELECT 1 FROM public.clients c WHERE lower(c.email) = lower(l.email)
--   )
-- ORDER BY l.created_at DESC;
