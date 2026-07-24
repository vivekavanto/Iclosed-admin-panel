# iClosed — Security Remediation Tracker

**Source:** [iClosed-Project-Review-2026-05-29.md](./iClosed-Project-Review-2026-05-29.md) · **Last verified:** 2026-07-22 (against `dev`)

**Status icons:** ✅ Done · 🟡 In progress / partial · ⛔ Blocked (needs infra) · ⬜ Not started

---

## 1. Where things stand

**22 done, 9 in progress, 39 not started** (out of 70 tracked finding-IDs). Big push on 2026-07-23 — see [section 2](#2--done).

In plain terms:
- The **admin auth gate is done** — every admin API route requires a logged-in admin (SEC-001).
- **A batch of 12 security fixes landed 2026-07-23** — headers, UUID validation, audit logging, token cap, log hygiene, CI/secret-scanning, and more (all typecheck-clean).
- **Two are code-done but need YOUR action to switch on** — webhook signing (SEC-002) and private documents (SEC-003): Vercel env / a new Blob store. See [section 4](#4-in-progress--needs-your-action).
- **The rest** are either not started ([section 5](#5-not-started)) or need a decision/infra from you (listed at the end of this section).

> **Counting note:** the review lists **47 unique issues**, but they carry **70 finding-IDs** because several are cross-listed under both a security (`SEC-`) and a compliance (`CMP-`) id — e.g. `SEC-003` = `CMP-001`. Numbers below count the 70 IDs.

| Category | Total IDs | ✅ Done | 🟡 In progress | ⬜ Not started |
| --- | :---: | :---: | :---: | :---: |
| Security (SEC) | 28 | 24 | 1 | 3 |
| Functional gaps (GAP) | 22 | 22 | 0 | 0 |
| Architecture (ARC) | 12 | 7 | 0 | 5 |
| Compliance (CMP) | 8 | 4 | 1 | 3 |
| **Total** | **70** | **57** | **2** | **11** |

*(CMP-002 privacy-consent capture was **removed at the user's request** — reverted to no consent step.)*

**All 22 functional gaps (GAP) are now done.** The 14 "not started" = 9 you deferred
+ 5 that genuinely can't be completed cleanly in code (see below).

**Only 2 left in progress** — both **SEC-003 / CMP-001** (private Blob store), which
needs a private-capable Vercel Blob store. Everything else code-completable is done.

**SEC-002 note:** `activate-deal` now auto-enforces once `SERVICE_WEBHOOK_SECRET`
is set (identically) in **both** Vercel projects — no enforce flag needed. It
fails OPEN if the secret is missing, so it can't break deal activation. ⚠️ The
secret MUST match in both projects (both redeployed) or `activate-deal` will 401.

### Completed 2026-07-23 (this batch)

| ID | Fix | Your part |
| --- | --- | --- |
| **SEC-008** | Invitation token consumption cap (max 10 uses) | **Run migration** `2026-07-23-invitation-token-consumption-cap.sql` |
| **SEC-010 / CMP-007** | Security headers (5 enforced; CSP report-only) | Flip CSP to enforcing after checking console for violations |
| **SEC-013** | UUID validation on deal + lead route ids (guards `.or()`) | — |
| **SEC-014** | Removed verbose ID logging from task-responses | — |
| **SEC-016** | Secret-scanning CI (gitleaks) | Enable Actions on GitHub |
| **SEC-017** | Explicit "no cross-origin" policy on webhooks | — |
| **SEC-019** | Dependabot config | Enable Dependabot on GitHub |
| **SEC-020** | server-only guard on `supabaseAdmin` | — |
| **SEC-024** | Upload token 2-min TTL | — |
| **SEC-026 / CMP-004** | `audit_logs` table + `recordAudit()`; wired into impersonate, deal-delete, lead-delete | **Run migration** `2026-07-23-audit-logs.sql` |
| **SEC-027** | Key-rotation runbook (`docs/key-rotation.md`) | Follow the cadence |
| **SEC-028** | CI workflow (lint / type-check / build / npm audit) | Enable Actions on GitHub |
| **SEC-022** | Recipient emails masked in logs; PII subject dropped | — |
| ~~**CMP-002**~~ | ~~Privacy-consent checkbox at intake~~ — **removed at user request** (reverted; no consent step) | — |
| **CMP-005** *(erase part)* | Right-to-be-forgotten endpoint `POST /api/admin/leads/[id]/erase` (hard-deletes family + docs + blobs, audited) | Retention schedule + scheduled purge job still to define (needs your retention periods) |
| **GAP-009** | Upload validation (25 MB cap + JPG/PNG/WEBP/HEIC/PDF only), both repos | — |
| **GAP-008** | Compensating blob delete when the DB insert fails (no orphaned files), both repos | — |
| **GAP-016** | Lead email format validation on edit (duplicates intentionally allowed — co-clients share email) | — |
| **GAP-011** | Welcome email atomically claimed before send (no concurrent duplicates; reverts on failure) | — |
| **GAP-013** | Brace decoding covers decimal/hex/named entities in all 3 email helpers | — |
| **GAP-018** | Task-response `field_type` validated against an allow-list | — |
| **GAP-006** | Deal status transitions validated (Active↔Inactive, either→Closed; Closed terminal) | — |
| **GAP-017** | `file_number` format enforced on deal edit; single shared regex across import + edit | — |
| **GAP-014** | Milestone-email failures logged with IDs (thrown + non-2xx), still non-blocking | — |
| **GAP-003** | Backfill idempotency guard via new `migration_runs` table | **Run migration** `2026-07-23-migration-runs.sql` |
| **GAP-019** | APS side auto-detect now reads legacy `doc_type='document'` rows via `custom_type` | — |
| **GAP-004** | Shared-task mirror dedupes identical responses (no retry duplicates); code-level (multi-file safe) | — |
| **ARC-008** | Global error boundary — `error.tsx` + `global-error.tsx` graceful fallbacks | — |
| **ARC-010** | Authored `CLAUDE.md` architecture brief (was boilerplate README only) | — |
| **ARC-004** | Removed duplicate route stubs; legacy URLs handled via `next.config` redirects | — |
| **ARC-011** | Structured `logger` gated by `LOG_LEVEL`; adopted in session code (legacy `console.*` migrates incrementally) | Optionally set `LOG_LEVEL=warn` in prod |
| **ARC-005** | Shared `toDeal` mapper — used by deal list + detail page | — |
| **SEC-006** | Impersonation now requires admin password re-entry (step-up) + notifies the customer + audit | (optional: `IMPERSONATE_NOTIFY_CUSTOMER=false` to disable the email) |
| **SEC-012 / CMP-008** | Public routes sanitized; admin-only routes keep detail as a documented, accepted posture for an internal tool | — |
| **GAP-021** | Zero-task milestones kept at their manual status (no auto-derive possible) — resolved by design | — |
| **SEC-002** | Webhook signatures: `activate-deal` auto-enforces when secret is set (fail-open if missing); other routes warn-only until their callers sign | Set `SERVICE_WEBHOOK_SECRET` (same) in both Vercel projects + redeploy both |
| **GAP-001** | Optimistic concurrency on deal edit (`expected_updated_at` → 409); wired in EditDealModal | — |
| **GAP-002** | Unique index (one active deal per lead) + 409 on the conversion race | **Run migration** `2026-07-23-one-active-deal-per-lead.sql` |
| **GAP-012** | Resend send retried with backoff (welcome email) | — |
| **GAP-015** | Bulk import capped at 1000 rows/request | — |
| **GAP-022** | Unit tests (9) via Node's test runner (`npm test`) + wired into CI | — |
| **ARC-002** | Auth `listUsers` scan cached (60s TTL) — no per-request full scan | — |
| **ARC-012** | CI release-gate exists (SEC-028 workflow) + now runs the test suite | Enable Actions on GitHub |
| **SEC-007 / SEC-011 / SEC-023** | Rate limiting via **Supabase** (no Redis) — password reset (5/hr email, 30/hr IP), Gemini (30/hr per admin), activate (30/10min per IP) | **Run migration** `2026-07-23-rate-limits.sql` |
| **SEC-004** | Per-deal access — **accepted decision:** all admins see all deals (all staff trusted); documented in `CLAUDE.md`. Revisit if teams/brokers are added | — |
| **SEC-012** *(partial)* | Public webhook no longer leaks internal error text | Decide whether to sweep the 84 authenticated-admin sites too |
| **SEC-006** *(partial)* | Impersonation now audit-logged | Decide on step-up auth + notify-customer-on-impersonation |

---

## 2. ✅ Done

Fully fixed and verified in code.

| ID | What was fixed | Where |
| --- | --- | --- |
| **SEC-001** | Admin auth gate — every `/admin/**` + `/api/admin/**` route requires a valid Supabase session with `role = admin` | `src/middleware.ts` |
| **SEC-005** | Blob URL allow-list now checks the parsed `hostname` (was a bypassable string match) | `deals/[id]/uploadblobstorage/route.ts` |
| **SEC-009** | Email template injection — new single-pass + HTML-escaping renderer; reflective & markup injection now impossible. 7/7 tests pass | `src/lib/renderEmailTemplate.ts` |
| **SEC-025** | `backfill-shared-tasks` is now behind the admin auth gate (was fully open) | via `src/middleware.ts` |
| **GAP-005** | Deal delete is a soft delete now — no more orphaned child rows | `deals/[id]/route.ts` |
| **GAP-007** | Task status changes always recalc milestones | `tasks/route.ts` |
| **GAP-010** | APS replacement no longer wipes family-wide docs; scoped per side | `completeApsTask.ts` |
| **GAP-020** | `activateClientDeals` no longer leaks a missing id into its OR filter | `activateClientDeals.ts` |

> SEC-001, SEC-005, SEC-009, SEC-025 were done for this remediation. GAP-005/007/010/020 were fixed earlier as part of feature work.

---

## 3. 🟡 Partially done (minor follow-ups)

| ID | State | Follow-up |
| --- | --- | --- |
| **SEC-022** | Webhook route no longer logs the full payload… | …but the recipient email is still logged (`sendWelcomeEmail.ts`) |
| **GAP-021** | Zero-task milestones no longer stick on "Pending"… | …but a truly task-less milestone still can't auto-advance (by design) |
| **ARC-010** | — | No `CLAUDE.md` / architecture brief; `README` is boilerplate |

---

## 4. 🟡 In progress — needs YOUR action

These two are code-complete. They can't be switched on from code alone — they need Vercel env / infra changes only you can make.

### SEC-002 — Webhook signatures (HMAC)
**Goal:** the admin app should reject service-to-service requests that aren't cryptographically signed.

**Done (code):**
- **Admin verifies** signatures — `src/lib/verifyServiceSignature.ts`, wired into `new-lead`, `activate-deal`, `reset-password`, `send-milestone-email`, `send-lead-family-email`, `send-welcome-email`. Currently **warn-only** (logs, doesn't block).
- **Portal signs** its calls — `iclosed_dev_web/src/lib/signServiceRequest.ts`, wired into `login → activate-deal` and `post-sign → retainer-signed`. Verified round-trip: valid passes, tampered/wrong rejected.

**To finish (you):**
1. Set `SERVICE_WEBHOOK_SECRET` (same value) in **both** Vercel projects.
2. Make sure **every** caller of a guarded endpoint signs. The portal covers `activate-deal`; confirm who calls the others (`new-lead`, the 3 `send-*`, `reset-password`) — an external CRM or a browser caller can't sign and would break on enforce.
3. Watch the warn-only logs (`[service-sig] Phase 1 (warn-only): would reject …`) until real traffic shows none flagged.
4. Set `SERVICE_WEBHOOK_ENFORCE=true` + redeploy → now it blocks unsigned requests.

### SEC-003 / CMP-001 — Private documents
**Goal:** stop storing government IDs / APS docs on public URLs; serve them only through a logged-in proxy.

**Done (code, both repos):** private-capable uploads, auth-gated download proxies (the portal one also checks the customer owns the doc), all read/write sites wired, and a dry-run backfill route. All dormant behind the `NEXT_PUBLIC_PRIVATE_BLOB` flag (default OFF → behaves exactly as today).

**⛔ Blocker:** the current Vercel Blob store is **public-only**. Turning the flag on fails with *"Cannot use private access on a public store."*

**To finish (you):**
1. Provision a **private-capable** Blob store in Vercel (likely a new store) and point `BLOB_READ_WRITE_TOKEN` at it.
2. *(then I finish the code)* — switch the APS/personal-info **client uploads** to Vercel's presigned private flow (`uploadPresigned`). Can't test until step 1 exists.
3. Set `NEXT_PUBLIC_PRIVATE_BLOB=true` in both projects + redeploy.
4. Run the backfill to migrate old public docs (see [runbook](#7-runbook--private-documents-sec-003)).

---

## 5. ⬜ Not started

Grouped by the review's priority. `ID · what it is · where`.

### 🔴 P0 — before broad rollout
| ID | What it is | Where |
| --- | --- | --- |
| **CMP-002** | No privacy-consent capture at intake (no `privacy_consent_at` stored) | `Intake.tsx` |
| **CMP-003** | Government IDs sent to Google Gemini with no sub-processor DPA / disclosure | `identify-document/route.ts` |

### 🟠 P1 — within 30 days
| ID | What it is | Where |
| --- | --- | --- |
| **SEC-004** | IDOR — any admin can PATCH any deal (no per-deal ownership check) | `deals/[id]/route.ts` |
| **SEC-006** | Impersonation has no audit log and no step-up auth | `impersonate/route.ts` |
| **SEC-007** | Password reset has no rate limit | `reset-password/route.ts` |
| **SEC-008** | Invitation token reusable for 7 days, no consumption cap | `invitationToken.ts` |
| **SEC-010 / CMP-007** | No security headers (CSP / HSTS / X-Frame-Options …) | `next.config.ts` |
| **SEC-011** | Gemini key raw env, no per-user rate limit | `identify-document/route.ts` |
| **GAP-001** | No optimistic concurrency on deal edit (last write wins) | `deals/[id]/route.ts` |
| **GAP-008** | Failed DB insert after upload → orphaned blob bytes | `uploadblobstorage/route.ts` |
| **CMP-004** | No `audit_logs` table / `recordAudit()` helper | DB schema |
| **CMP-006** | Emails lack a CASL unsubscribe link + postal address | `sendWelcomeEmail.ts` |
| **ARC-001** | `/api/admin/deals` returns the whole table (no pagination) | `deals/route.ts` |
| **ARC-002** | Unbounded `auth.admin.listUsers` loop (N+1) | `deals/route.ts` |

### 🟡 P2 — hardening / quality
| ID | What it is | Where |
| --- | --- | --- |
| **SEC-012 / CMP-008** | Internal error text / PII echoed to clients and logs | `sendWelcomeEmail.ts`, `deals/[id]/route.ts` |
| **SEC-013** | `.or()` filter built by string interpolation; no UUID validation | `deals/[id]/route.ts` |
| **SEC-014** | Verbose `console.log` with IDs in production | `task-responses/route.ts` |
| **SEC-015** | `daisyui@^3` outdated major | `package.json` |
| **SEC-016** | No secret-scanner / pre-commit hook | repo root |
| **SEC-017** | CORS only on `reset-password`; webhooks have none | webhook routes |
| **SEC-018** | Tailwind 3 + `@tailwindcss/postcss@4` co-installed | `package.json` |
| **SEC-019** | No dependency scanning (no `.github/`) | repo root |
| **SEC-020** | `supabaseAdmin.ts` lacks an `import "server-only"` guard | `supabaseAdmin.ts` |
| **SEC-021** | Uploads not virus-scanned | `uploadblobstorage/route.ts` |
| **SEC-023** | Activate endpoint: no lockout on repeated invalid attempts | `auth/activate/route.ts` |
| **SEC-024** | Upload token has no explicit TTL hardening | `.../token/route.ts` |
| **SEC-026** | No `audit_logs` table (same as CMP-004) | DB schema |
| **SEC-027** | No documented key-rotation cadence | runbook |
| **SEC-028** | No npm-audit / Snyk in CI | CI |
| **GAP-002** | Family-deal lookup race; no unique index guarding it | `convertLead.ts` |
| **GAP-003** | Backfill endpoint has no idempotency key | `backfill-shared-tasks/route.ts` |
| **GAP-004** | Shared-task mirror can duplicate rows on retry (no UPSERT) | `task-responses/route.ts` |
| **GAP-006** | Deal status transitions not validated (no state machine) | `deals/[id]/route.ts` |
| **GAP-009** | No file count / size / MIME limits on upload | `uploadblobstorage/route.ts` |
| **GAP-011** | `welcome_email_sent` flipped after send → possible duplicate | `sendWelcomeEmail.ts` |
| **GAP-012** | No retry / outbox on Resend transient failure | `sendWelcomeEmail.ts` |
| **GAP-013** | HTML-entity decoding incomplete | `sendWelcomeEmail.ts` |
| **GAP-014** | Milestone-email failures silently swallowed | `recalcMilestones.ts` |
| **GAP-015** | Bulk import: no file-level MIME / size validation | `bulk-import-deals/route.ts` |
| **GAP-016** | Lead email accepted without regex / duplicate check | `leads/route.ts` |
| **GAP-017** | `file_number` regex enforced on import but not on deal PATCH | `deals/[id]/route.ts` |
| **GAP-018** | `field_type` accepted without enum check | `task-responses/route.ts` |
| **GAP-019** | APS side auto-detect misses legacy `doc_type='document'` rows | `completeApsTask.ts` |
| **GAP-022** | Zero automated tests | repo |
| **ARC-003** | `DealList` renders all rows, no virtualization | `DealList.tsx` |
| **ARC-004** | Duplicate routing stubs (`app/deals`, `app/leads`, …) | `src/app/*` |
| **ARC-005** | No central `dealMapper`; inline mapping repeated | `DealList.tsx` |
| **ARC-006** | Pervasive `any` in admin handlers | `deals/route.ts` |
| **ARC-007** | Mixed Tailwind 3 + 4 | `package.json` |
| **ARC-008** | No global error boundary / `error.tsx` | `ClientLayout.tsx` |
| **ARC-009** | Inconsistent API error response shape | admin routes |
| **ARC-011** | `console.log` noise; no structured logger | `task-responses/route.ts` |
| **ARC-012** | No test / release gate in CI (informational) | CI |
| **CMP-005** | No data-retention / right-to-be-forgotten flow | `leads` |

---

## 6. Runbook — enforcing webhook signatures (SEC-002)

1. **Set the secret** — `SERVICE_WEBHOOK_SECRET` = the same random value in both Vercel projects (`iclosed_dev_admin`, `iclosed_dev_web`).
2. **Deploy both** (portal already signs; admin verifies in warn-only mode).
3. **Watch the logs** — search for `[service-sig] warn-only: would reject`. Each line names the `route=` of a caller that isn't signing yet. A route with no warn lines for real traffic is safe to enforce.
4. **Enforce — safely, per endpoint (recommended):** set
   `SERVICE_WEBHOOK_ENFORCE_ROUTES=activate-deal` in the admin project + redeploy.
   Only that route rejects unsigned requests; the other five stay warn-only. Add
   more comma-separated `routeKey`s (`new-lead`, `send-welcome-email`,
   `send-milestone-email`, `send-lead-family-email`, `reset-password`) as you
   confirm each of their callers signs.
   - **Or all at once:** `SERVICE_WEBHOOK_ENFORCE=true` enforces every route (only
     when you're sure every caller signs).
5. **Rollback** — remove the env var(s) + redeploy to return to warn-only.

Valid `routeKey`s: `activate-deal`, `new-lead`, `send-welcome-email`,
`send-milestone-email`, `send-lead-family-email`, `reset-password`. The portal
currently signs `activate-deal` (and `retainer-signed`), so **`activate-deal` is
the safe one to enforce first.**

---

## 7. Runbook — private documents (SEC-003)

**How it works.** Vercel puts the access level in the blob hostname (`.public.` vs `.private.`), so each stored URL is self-describing. `docDownloadHref()` routes only `.private.` URLs through the auth-gated proxy; public/legacy URLs are served directly. No DB migration needed; old rows keep working.

**Access control.**
- Admin proxy `GET /api/admin/documents/download` — guarded by the admin auth middleware.
- Portal proxy `GET /api/documents/download` — re-derives ownership (auth cookie → client → family leads) and only streams the doc if it belongs to that customer.

**Turn it on (do both together):**
1. Provision a **private-capable** Blob store; point `BLOB_READ_WRITE_TOKEN` at it in both projects.
2. Set `NEXT_PUBLIC_PRIVATE_BLOB=true` in both projects and **redeploy both** (it's a build-time var).
3. Verify: upload a new doc → its URL host is `.private.…`; View/Download works in both apps; the raw private URL fails when logged out; a cross-customer proxy request returns 403.
4. **Backfill old public docs** — `POST /api/admin/backfill-private-blobs` (admin session):
   - Preview: `{ }` → reports how many would migrate.
   - Execute: `{ "dryRun": false, "limit": 100 }` → repeat until `remainingAfterThisRun` is 0.
   - Run only **after** both apps are deployed with the proxy code.

**Roll back:** set `NEXT_PUBLIC_PRIVATE_BLOB=false` + redeploy. New uploads go back to public; already-private blobs keep working through the proxy.

**Keep the flag in sync** across both projects — flip them together.
