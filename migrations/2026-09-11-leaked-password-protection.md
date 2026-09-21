# 2026-09-11-leaked-password-protection

## Issue
Supabase linter warning: `auth_leaked_password_protection` - Leaked password protection is currently disabled.

## What it does
Supabase Auth prevents the use of compromised passwords by checking them against HaveIBeenPwned.org. This is a critical security feature that should be enabled.

## How to fix
This cannot be fixed via SQL migration. It must be enabled in the Supabase dashboard:

1. Go to the Supabase project dashboard
2. Navigate to **Authentication → Password and Confirmations**
3. Under "Leaked password protection", toggle it **ON**
4. Save the changes

Alternatively, use the Supabase API or CLI to enable this setting.

## Reference
https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## Applied?
- [ ] Enable in Supabase dashboard
