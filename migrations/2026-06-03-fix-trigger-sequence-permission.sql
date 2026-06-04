-- 2026-06-03-fix-trigger-sequence-permission.sql
--
-- Bug: intake (lead INSERT) failed with "permission denied for sequence
-- clients_code_seq". The sync_lead_to_clients trigger inserts into clients,
-- whose customer_code DEFAULT calls nextval('clients_code_seq'). The trigger
-- runs as the CALLER's role (intake uses a limited role) which lacks USAGE on
-- that sequence — so the insert (and the whole intake) is rejected.
--
-- Fix: make the lead->clients trigger functions SECURITY DEFINER so they run
-- with the (privileged) function-owner's rights, regardless of who inserted the
-- lead. Also grant sequence usage as a safety net for any direct client insert
-- under a limited role.

CREATE OR REPLACE FUNCTION public.sync_lead_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  -- Staff/admin emails belong in admin_users, not clients.
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.clients (email, first_name, last_name, phone, converted)
  VALUES (NEW.email, NEW.first_name, NEW.last_name, NEW.phone, false)
  ON CONFLICT (lower(email)) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_client_converted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'Converted'
     AND COALESCE(OLD.status, '') <> 'Converted'
     AND NEW.email IS NOT NULL THEN
    UPDATE public.clients SET converted = true
    WHERE lower(email) = lower(NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

GRANT USAGE, SELECT ON SEQUENCE public.clients_code_seq
  TO anon, authenticated, service_role;
