# Staff accounts and module access

Staff register at `/admin/signup` using an exact `navawilson.law` or `iclosed.ca` email domain. Existing accounts use the same login; this does not create a separate identity store. Supabase must keep email confirmation enabled. Eligibility is enforced again on the server, so an arbitrary email submitted directly to the shared customer-auth endpoint never grants staff access.

The verified `saru@navawilson.law` account is the owner. `/admin/access` and `/api/admin/access` are owner-only. The owner grants module IDs and can disable portal access. New accounts and new staff invitations have no modules by default. Existing legacy admins retain modules until explicitly scoped. Staff profiles and module grants are separate: a Clerk/Lawyer/Admin display label cannot grant permissions. The owner cannot be disabled or reassigned through these screens.

`app_metadata.staff_modules` and `app_metadata.staff_disabled` are server-owned claims, updated only through the owner API. Never use editable `user_metadata` for authorization. Existing unrelated metadata is preserved. Changes record the actor/time in metadata and use the existing best-effort audit logger. The existing auth account, password and customer records are preserved. No database migration is required.

Middleware revalidates `getUser()` and enforces module access on pages and APIs. The sidebar hides unavailable modules; the API gate remains authoritative even if a stale browser menu is visible. Users should sign out/in after grants to refresh the menu. Unknown routes and administrative maintenance endpoints are owner-only. Existing explicitly public customer/service endpoints retain their current independent authentication.

These are module permissions, not per-file, per-field or read/write permissions. All Files and Tasks share supporting file record reads; Dashboard and Search do not independently grant access to those APIs. Record writes require the owning operational module. Supporting template/calendar reads are shared with the forms that need them. The public calculator remains public. Database RLS/customer-portal permissions are unchanged and must be assessed separately for database-wide isolation. Future module routes must be added to the central policy with tests; unclassified APIs fail closed to owner-only.

## Deployment and acceptance

Keep Supabase signup enabled and email auto-confirm disabled. These were checked read-only during development. Add each deployed origin's `/admin/auth/confirm` URL to Supabase Authentication URL Configuration Redirect URLs, preserving existing customer callbacks. For dev use `https://devadmin.iclosed.ca/admin/auth/confirm`; localhost preview uses `http://127.0.0.1:3004/admin/auth/confirm`. Do not replace the shared Site URL or alter customer email templates as routine setup.

The callback exchanges a PKCE code and only redirects within the same origin. The verification email should be opened in the browser used to register. Confirmation callbacks are omitted from Next incoming request logs. Live delivery, redirect allowlist, and end-to-end email acceptance need verification before rollout; no real signup emails or permission updates were sent during automated tests.

Acceptance: register a controlled company test address, verify email, confirm no tabs and denied direct API access; use Saru's User Access page to grant Finance only; confirm Finance appears while Legal Assistant and User Access are blocked; revoke Finance and verify subsequent API calls are denied. Test account creation and grant changes require a controlled test account because the Supabase project is shared with the customer portal.
