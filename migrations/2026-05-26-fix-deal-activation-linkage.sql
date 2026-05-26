-- 2026-05-26 — Fix deal activation on first sign-in.
--
-- Root cause: convertLead set deals.client_id but not leads.client_id, so
-- activate_deals_on_first_signin() could not join leads → clients → auth user.
-- Also widen the trigger to match deals.client_id directly.
--
-- Pieces:
--   1. Backfill leads.client_id from deals where missing.
--   2. Backfill clients.lead_id from deals where missing (if column exists).
--   3. Promote Inactive → Active for clients who already signed in.
--   4. Replace trigger function with the fixed join paths.

BEGIN;

-- 1. Backfill lead ↔ client link from the deal row.
UPDATE public.leads l
SET client_id = d.client_id
FROM public.deals d
WHERE d.lead_id = l.id
  AND d.client_id IS NOT NULL
  AND l.client_id IS NULL;

-- 2. Backfill clients.lead_id when the column exists (used by family auth lookups).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clients'
      AND column_name = 'lead_id'
  ) THEN
    UPDATE public.clients c
    SET lead_id = d.lead_id
    FROM public.deals d
    WHERE d.client_id = c.id
      AND d.lead_id IS NOT NULL
      AND c.lead_id IS NULL;
  END IF;
END $$;

-- 3. Clients who already signed in but deals stayed Inactive.
UPDATE public.deals d
SET status = 'Active'
WHERE d.status = 'Inactive'
  AND (
    EXISTS (
      SELECT 1
      FROM public.leads l
      JOIN public.clients c ON c.id = l.client_id
      JOIN auth.users u ON u.id = c.auth_user_id
      WHERE l.id = d.lead_id
        AND u.last_sign_in_at IS NOT NULL
    )
    OR EXISTS (
      SELECT 1
      FROM public.clients c
      JOIN auth.users u ON u.id = c.auth_user_id
      WHERE c.id = d.client_id
        AND u.last_sign_in_at IS NOT NULL
    )
  );

-- 4. Trigger: promote Inactive deals on first sign-in (both linkage paths).
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
    AND (
      d.lead_id IN (
        SELECT l.id
        FROM public.leads l
        JOIN public.clients c ON c.id = l.client_id
        WHERE c.auth_user_id = NEW.id
      )
      OR d.client_id IN (
        SELECT c.id
        FROM public.clients c
        WHERE c.auth_user_id = NEW.id
      )
    );
  RETURN NEW;
END;
$$;

-- 5. Ensure the trigger exists on auth.users (function alone does nothing).
DROP TRIGGER IF EXISTS deals_activate_on_first_signin ON auth.users;
CREATE TRIGGER deals_activate_on_first_signin
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.last_sign_in_at IS NULL AND NEW.last_sign_in_at IS NOT NULL)
  EXECUTE FUNCTION public.activate_deals_on_first_signin();

COMMIT;
