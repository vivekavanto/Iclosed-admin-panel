-- 2026-06-03-setup-users-registry.sql
--
-- Purpose: make public.users the real STAFF REGISTRY so staff/admin users can
-- be listed, managed, and tracked reliably going forward. Until now this table
-- was defined but completely unused (no code reads or writes it).
--
-- IMPORTANT — this migration is ADDITIVE and changes NOTHING about the existing
-- login / auth flow:
--   * It does NOT touch auth.users.
--   * It does NOT change app_metadata or the middleware admin gate. Login still
--     works exactly as before (auth.users + app_metadata.role === 'admin').
--   * public.users is only a human-readable registry. auth.users remains the
--     source of truth for authentication (passwords, sessions). The two link by
--     a shared id.
--
-- Role casing note: the LOGIN gate uses lowercase app_metadata.role = 'admin'.
-- This registry's `role` column is a separate JOB-TITLE label ('Admin' |
-- 'Clerk' | 'Lawyer'). They are independent on purpose — do not couple them.

-- This works ON THE EXISTING public.users table (id uuid PK, name, role with a
-- CHECK for Admin/Clerk/Lawyer, avatar_url, created_at). It only ADDS to it.

-- 1. Add the columns the registry needs (idempotent / safe to re-run).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email      text,
  ADD COLUMN IF NOT EXISTS is_active  boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS phone      text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2. `id` must now equal the login account's id (auth.users.id), not a fresh
--    random uuid — that's what links a registry row to a real login. Drop the
--    gen_random_uuid() default so a row can only be created with a real auth id.
ALTER TABLE public.users ALTER COLUMN id DROP DEFAULT;

-- 2b. Safety: if the table currently holds stale rows whose id is NOT a real
--     auth account (e.g. old seed/test data), the FK in step 3 would fail.
--     Since this table is unused by any code, clear those orphans first.
--     (Rows that DO match an auth user are kept.)
DELETE FROM public.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);

-- 3. Link each registry row to its login account in auth.users via shared id.
--    ON DELETE CASCADE: if a login account is ever deleted, its registry row
--    goes too (no orphans).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_id_fkey'
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE;
  END IF;
END $$;

-- 4. One registry row per email (case-insensitive) — prevents duplicate staff.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key
  ON public.users (lower(email));

-- 5. Keep updated_at fresh on every edit. This trigger touches ONLY
--    public.users — it has no effect on auth or any existing flow.
CREATE OR REPLACE FUNCTION public.users_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON public.users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.users_set_updated_at();

-- 6. Backfill a registry row for every EXISTING admin so the Staff list is
--    populated from day one. Name is derived from auth metadata, falling back
--    to the email's local part. Role label defaults to 'Admin'.
INSERT INTO public.users (id, email, name, role, avatar_url, created_at, is_active)
SELECT
  u.id,
  u.email,
  COALESCE(
    NULLIF(TRIM(CONCAT_WS(' ',
      u.raw_user_meta_data ->> 'first_name',
      u.raw_user_meta_data ->> 'last_name')), ''),
    NULLIF(TRIM(u.raw_user_meta_data ->> 'name'), ''),
    NULLIF(TRIM(u.raw_user_meta_data ->> 'display_name'), ''),
    split_part(u.email, '@', 1)
  ) AS name,
  'Admin' AS role,
  u.raw_user_meta_data ->> 'avatar_url' AS avatar_url,
  u.created_at,
  true AS is_active
FROM auth.users u
WHERE u.raw_app_meta_data ->> 'role' = 'admin'
ON CONFLICT (id) DO NOTHING;

-- 7. Human-readable staff code (USR-0001, USR-0002, ...). The UUID `id` stays
--    the technical primary key + auth link (humans never need to read it);
--    `staff_code` is the friendly identifier shown in the UI and used for
--    reference in a future CRM. Auto-generated, sequential, unique.
CREATE SEQUENCE IF NOT EXISTS public.users_code_seq;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS staff_code text;

-- Assign a code to any existing row that doesn't have one (the backfilled
-- admins). Re-run safe: only touches NULLs.
UPDATE public.users
SET staff_code = 'USR-' || lpad(nextval('public.users_code_seq')::text, 4, '0')
WHERE staff_code IS NULL;

-- New rows automatically get the next code.
ALTER TABLE public.users
  ALTER COLUMN staff_code SET DEFAULT 'USR-' || lpad(nextval('public.users_code_seq')::text, 4, '0');

ALTER TABLE public.users
  ALTER COLUMN staff_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_staff_code_key
  ON public.users (staff_code);

-- NOTE: there is intentionally NO trigger on auth.users. Keeping the registry
-- in sync going forward is handled explicitly by the /api/admin/users route
-- (invite / edit / deactivate). This avoids attaching any trigger to the auth
-- signup path, so the existing login/signup flow is left completely untouched.
