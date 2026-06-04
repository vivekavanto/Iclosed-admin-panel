-- 2026-06-03-rename-to-admin-users.sql
--
-- Purpose: name the staff/admin registry table clearly. The table previously
-- called public.users is renamed to public.admin_users, since it holds
-- admin/staff records (NOT customers — customers live in public.clients).
--
-- The RENAME preserves everything: all rows, the USR-#### codes, the
-- backfilled admins, every column, index, FK and trigger carry over unchanged.
-- This also adds the admin-record maintenance columns (title, last_login_at,
-- created_by, deactivated_at).
--
-- ADDITIVE / safe: does NOT touch auth.users, login, or any flow.
-- Prereq: the users-registry migration (2026-06-03-setup-users-registry.sql)
-- has already created/populated public.users.

-- 1. Rename the table. Idempotent: only renames if public.users still exists
--    and admin_users doesn't yet.
DO $$
BEGIN
  IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      )
     AND NOT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'admin_users'
      )
  THEN
    ALTER TABLE public.users RENAME TO admin_users;
  END IF;
END $$;

-- (Index / sequence / trigger names may still read "users_*" — that is cosmetic
--  only; they remain attached to admin_users and keep working.)

-- 2. Admin-record maintenance columns.
ALTER TABLE public.admin_users
  ADD COLUMN IF NOT EXISTS title          text,         -- job designation, e.g. "Senior Lawyer"
  ADD COLUMN IF NOT EXISTS last_login_at  timestamptz,  -- last time they signed in
  ADD COLUMN IF NOT EXISTS created_by     uuid,         -- which admin added this person
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz;  -- when they were deactivated

-- created_by → the auth account of the admin who created the record.
-- SET NULL if that admin is ever removed, so we never orphan-block a delete.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'admin_users_created_by_fkey'
  ) THEN
    ALTER TABLE public.admin_users
      ADD CONSTRAINT admin_users_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. Backfill last_login_at from Supabase auth's last_sign_in_at so existing
--    admins show a real value immediately. (Kept fresh afterwards by the
--    /api/admin/users GET handler, which reads auth per staff member.)
UPDATE public.admin_users u
SET last_login_at = a.last_sign_in_at
FROM auth.users a
WHERE a.id = u.id
  AND a.last_sign_in_at IS NOT NULL;

-- 4. Use an ADM- prefix for the code (this is the admin table — USR- was the
--    generic name). Keeps the same number, just swaps the prefix.
UPDATE public.admin_users
SET staff_code = regexp_replace(staff_code, '^USR-', 'ADM-')
WHERE staff_code LIKE 'USR-%';

-- New rows get ADM-#### from the same sequence (sequence name stays
-- users_code_seq — cosmetic — and keeps the numbering continuous).
ALTER TABLE public.admin_users
  ALTER COLUMN staff_code
  SET DEFAULT 'ADM-' || lpad(nextval('public.users_code_seq')::text, 4, '0');
