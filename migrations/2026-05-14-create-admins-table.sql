-- Tag specific Supabase auth users as admins by writing role="admin" into
-- their app_metadata JSONB. No new table required — uses the built-in
-- raw_app_meta_data column on auth.users.
--
-- After running this, the admin login flow checks
-- user.app_metadata.role === "admin" and rejects everyone else (including
-- customers who share the same auth.users pool).
--
-- ─────────────────────────────────────────────────────────────────────
-- 1. Tag your admin user(s)
-- ─────────────────────────────────────────────────────────────────────
-- IMPORTANT: Replace the email below with your actual admin email(s).
-- The user must already exist in auth.users (i.e., you've signed up at
-- least once with that email). Run one statement per admin.

UPDATE auth.users
SET raw_app_meta_data =
  COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
WHERE email = 'yoga@avanto.ca';   -- ← REPLACE with your admin email

-- Add more admins like this:
-- UPDATE auth.users
-- SET raw_app_meta_data =
--   COALESCE(raw_app_meta_data, '{}'::jsonb) || '{"role": "admin"}'::jsonb
-- WHERE email = 'another-admin@example.com';

-- ─────────────────────────────────────────────────────────────────────
-- 2. Verify
-- ─────────────────────────────────────────────────────────────────────
SELECT
  email,
  raw_app_meta_data->>'role' AS role,
  CASE
    WHEN raw_app_meta_data->>'role' = 'admin' THEN '✅ Admin'
    ELSE '🟢 Frontend (customer)'
  END AS user_type
FROM auth.users
ORDER BY raw_app_meta_data->>'role' NULLS LAST, email;

-- ─────────────────────────────────────────────────────────────────────
-- To REMOVE admin access from a user later:
-- ─────────────────────────────────────────────────────────────────────
-- UPDATE auth.users
-- SET raw_app_meta_data = raw_app_meta_data - 'role'
-- WHERE email = 'former-admin@example.com';
