-- 2026-05-23 — Add "Pending" deal status; auto-flip to "Active" on first login.
--
-- Background: every newly-converted deal was being created with status='Active',
-- which made the All Files list show an Active badge for clients who hadn't yet
-- finished setting up their portal login. We now create deals as 'Pending' and
-- promote them to 'Active' the first time the linked client actually signs in.
--
-- Pieces:
--   1. Widen the deals_status_check CHECK constraint to allow 'Pending'.
--   2. Add a trigger on auth.users that flips Pending → Active when
--      last_sign_in_at transitions from NULL → NOT NULL (i.e. the user's
--      first successful sign-in).
--   3. Backfill: any existing deal whose linked client has already signed in
--      stays Active; deals whose client hasn't signed in yet stay as-is
--      (admins can manually mark them Pending if they want — we don't
--      retroactively flip Active deals back to Pending since that could
--      cause confusion in already-running files).

BEGIN;

-- 1. Widen the status CHECK constraint.
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_status_check
  CHECK (status IN ('Pending', 'Active', 'Inactive', 'Closed'));

-- 2. Trigger function: when a user signs in for the first time, promote
--    every Pending deal that belongs to them (via clients.auth_user_id →
--    leads.client_id → deals.lead_id) to Active.
CREATE OR REPLACE FUNCTION public.activate_deals_on_first_signin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.deals d
  SET status = 'Active'
  WHERE d.status = 'Pending'
    AND d.lead_id IN (
      SELECT l.id
      FROM public.leads l
      JOIN public.clients c ON c.id = l.client_id
      WHERE c.auth_user_id = NEW.id
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_activate_on_first_signin ON auth.users;
CREATE TRIGGER deals_activate_on_first_signin
  AFTER UPDATE OF last_sign_in_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.last_sign_in_at IS NULL AND NEW.last_sign_in_at IS NOT NULL)
  EXECUTE FUNCTION public.activate_deals_on_first_signin();

COMMIT;
