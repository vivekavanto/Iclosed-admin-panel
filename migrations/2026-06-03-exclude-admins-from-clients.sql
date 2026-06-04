-- 2026-06-03-exclude-admins-from-clients.sql
--
-- Purpose: keep admins/staff OUT of the customer table. admins belong in
-- public.admin_users; public.clients is for customers only.
--   1. Stop future admin emails from being synced into clients.
--   2. Remove existing admin rows from clients — but ONLY when they are not
--      referenced by a real deal or lead (so we never orphan real data).
--
-- Safe: deleting a clients row does NOT touch the admin's auth login or their
-- admin_users record — only the stray customer-table entry is removed.

-- 1. Update the lead->clients sync trigger to skip admin/staff emails.
CREATE OR REPLACE FUNCTION public.sync_lead_to_clients()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN
    RETURN NEW;
  END IF;

  -- Staff/admin emails belong in admin_users, not in the customer table.
  IF EXISTS (
    SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.clients (email, first_name, last_name, phone, converted)
  VALUES (NEW.email, NEW.first_name, NEW.last_name, NEW.phone, false)
  ON CONFLICT (lower(email)) DO NOTHING;

  RETURN NEW;
END;
$$;

-- 2. Remove admin rows from clients that are NOT referenced by any deal or lead.
--    Referenced ones are left untouched (that admin is also a real customer);
--    handle those manually if needed.
DELETE FROM public.clients c
WHERE lower(c.email) IN (
        SELECT lower(email) FROM public.admin_users WHERE email IS NOT NULL
      )
  AND NOT EXISTS (SELECT 1 FROM public.deals d WHERE d.client_id = c.id)
  AND NOT EXISTS (SELECT 1 FROM public.leads l WHERE l.client_id = c.id);
