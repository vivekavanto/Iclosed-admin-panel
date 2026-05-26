-- 2026-05-26 — Drop "Pending" deal status; statuses are now only Active/Inactive/Closed.
--
-- Background: deals.status used to support "Pending" for clients invited but not
-- yet signed in. Product decision: collapse that into "Inactive". A deal is
-- "Active" once the linked client has signed into the portal at least once,
-- and "Inactive" before then. "Closed" is unchanged.
--
-- Pieces:
--   1. Backfill: every existing Pending deal becomes Active (if the linked
--      auth user has last_sign_in_at) or Inactive (otherwise).
--   2. Replace the auto-flip trigger so it promotes Inactive → Active on
--      first sign-in (was Pending → Active).
--   3. Narrow the deals_status_check CHECK constraint to drop 'Pending'.

BEGIN;

-- 1. Backfill Pending deals based on whether the linked client has signed in.
UPDATE public.deals d
SET status = 'Active'
WHERE d.status = 'Pending'
  AND EXISTS (
    SELECT 1
    FROM public.leads l
    JOIN public.clients c ON c.id = l.client_id
    JOIN auth.users u ON u.id = c.auth_user_id
    WHERE l.id = d.lead_id
      AND u.last_sign_in_at IS NOT NULL
  );

UPDATE public.deals
SET status = 'Inactive'
WHERE status = 'Pending';

-- 2. Replace the trigger function so first-sign-in promotes Inactive (not Pending).
CREATE OR REPLACE FUNCTION public.activate_deals_on_first_signin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.deals d
  SET status = 'Active'
  WHERE d.status = 'Inactive'
    AND d.lead_id IN (
      SELECT l.id
      FROM public.leads l
      JOIN public.clients c ON c.id = l.client_id
      WHERE c.auth_user_id = NEW.id
    );
  RETURN NEW;
END;
$$;

-- 3. Narrow the CHECK constraint to drop 'Pending'.
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_status_check
  CHECK (status IN ('Active', 'Inactive', 'Closed'));

COMMIT;
