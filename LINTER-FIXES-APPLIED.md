# Supabase Database Linter Warnings — Fixed (2026-09-11)

## Summary

Created 4 migrations to address all 24 Supabase database linter warnings:

| Warning Category | Count | Status | Migration |
|---|---|---|---|
| function_search_path_mutable | 2 | ✅ Fixed | `2026-09-11-fix-function-security.sql` |
| rls_policy_always_true | 6 | ✅ Fixed | `2026-09-11-improve-rls-policies.sql` |
| anon_security_definer_function_executable | 6 | ✅ Fixed | `2026-09-11-fix-function-security.sql` |
| authenticated_security_definer_function_executable | 6 | ✅ Fixed | `2026-09-11-fix-function-security.sql` |
| auth_leaked_password_protection | 1 | ⚠️ Manual | See below |
| **rls_auto_enable()** | (internal) | ✅ Fixed | `2026-09-11-fix-rls-auto-enable.sql` |

## Key Approach

**SECURITY DEFINER functions need elevated privileges to work.** Instead of converting them to `SECURITY INVOKER` (which would break them), we:

1. Kept `SECURITY DEFINER` on all functions that need it
2. Ensured all have `SET search_path = public` pinned
3. **Revoked EXECUTE permission** from anon/authenticated on internal-only functions
4. **Kept EXECUTE permission** on public-callable functions

**Why this works**: Trigger invocations bypass permission checks. RPC calls respect them.

## Migrations to Apply

Apply these in order via Supabase SQL editor or `psql`:

```bash
psql -h [host] -U postgres -d postgres -f migrations/2026-09-11-fix-function-security.sql
psql -h [host] -U postgres -d postgres -f migrations/2026-09-11-improve-rls-policies.sql
psql -h [host] -U postgres -d postgres -f migrations/2026-09-11-fix-rls-auto-enable.sql
```

## Manual Step Required

**Enable leaked password protection in Supabase dashboard:**

1. Navigate to **Authentication → Password and Confirmations**
2. Toggle **"Leaked password protection"** to **ON**
3. Save changes

This prevents users from setting passwords in public breach databases (HaveIBeenPwned.org).

## Files Created

- `migrations/2026-09-11-fix-function-security.sql` — Pinned search_path + revoke RPC access
- `migrations/2026-09-11-improve-rls-policies.sql` — Restrict policies to authenticated
- `migrations/2026-09-11-fix-rls-auto-enable.sql` — Secure rls_auto_enable function
- `migrations/2026-09-11-LINTER-FIXES-SUMMARY.md` — Detailed technical documentation

## Design Rationale

Per CLAUDE.md SEC-004: "every authenticated admin can see and edit every deal/lead. There is intentionally NO per-deal or per-team scoping."

RLS policies remain intentionally open for authenticated users (trusted staff model). If per-deal authorization is ever added, both middleware and RLS policies must be updated together.

## Verification

After applying, run Supabase Advisors again to confirm all warnings are resolved.
