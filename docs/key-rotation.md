# Secret & Key Rotation Runbook (SEC-027)

Rotate these credentials on the cadence below, and immediately if a leak is ever
suspected (secret pushed to git, shared in a screenshot/log, laptop lost, or an
employee with access offboarded).

All secrets live in the Vercel project **Environment Variables** for both
`iclosed_dev_admin` and `iclosed_dev_web` — never in the repo. After rotating any
value, redeploy so the new value takes effect.

| Secret (env var) | Where issued | Rotate every | How to rotate |
| --- | --- | --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API | 90 days | Roll the service-role key in Supabase, update the env var in both projects, redeploy. High blast radius — do it in a low-traffic window. |
| `RESEND_API_KEY` | Resend → API Keys | 90 days | Create a new key, update env, redeploy, then delete the old key. |
| `GEMINI_API_KEY` / `API_KEY` | Google AI Studio / Cloud | 90 days | Create a new key (restrict by IP/referrer if possible), update env, redeploy, delete old. |
| `BLOB_READ_WRITE_TOKEN` | Vercel → Storage → Blob store | 180 days | Issue a new token for the store, update env in both projects, redeploy, revoke old. |
| `SERVICE_WEBHOOK_SECRET` | Self-generated (shared admin↔portal) | 180 days | Generate a new random value, set it in BOTH projects at once, redeploy both together (a mismatch breaks signed webhooks). |
| `ADMIN_SERVICE_KEY` (portal) | Self-generated | 180 days | Same as above — update everywhere it's referenced, redeploy. |
| Supabase anon key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) | Supabase → API | Only on suspected leak | Public by design (RLS-protected); rotate only if RLS assumptions change. |

## On a suspected leak
1. Rotate the affected secret immediately (steps above).
2. Revoke the old value at the provider so it can't be reused.
3. If the secret was committed to git, also scrub history (`git filter-repo`) and
   force-push — rotating alone doesn't remove it from the git history.
4. Check provider logs (Supabase, Resend, Google, Vercel Blob) for unexpected use.

## Prevention
- Secrets are gitignored (`.env*`) and never committed.
- CI runs a secret scan on every push/PR (`.github/workflows/gitleaks.yml`).
