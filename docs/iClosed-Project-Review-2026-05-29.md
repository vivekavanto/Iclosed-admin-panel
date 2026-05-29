# iClosed Admin Portal — Project Review

**Document version:** 1.0
**Review date:** 2026-05-29
**Prepared for:** iClosed stakeholders
**Prepared by:** Engineering Review Team
**Classification:** Confidential — client presentation use only

---

## 1. Executive Summary

The **iClosed Admin Portal** is a Next.js 16 (App Router) application that supports a Canadian real-estate transaction workflow: lead intake → conversion → deal management → tasks/milestones → document collection → client communication. The platform integrates Supabase (auth + Postgres), Vercel Blob (file storage), Resend (transactional email), and Google Gemini (AI document identification).

The product is **functionally rich and largely feature-complete** for its target use case. The codebase shows the hallmarks of fast iteration: a sizeable surface area of API routes, sophisticated family-deal logic (co-purchasers/co-sellers), and a comprehensive intake workflow. However, the review has surfaced a meaningful number of **security, compliance, and reliability gaps** that should be addressed before the product is scaled beyond a pilot deployment, particularly given the sensitive nature of the personal information it handles (government-issued IDs, addresses, contact details, transaction documents).

### Risk Dashboard

| Severity     | Count | Indicative theme                                                 |
| ------------ | :---: | ---------------------------------------------------------------- |
| **Critical** |   3   | Missing authentication, unauthenticated webhooks, public PII blobs |
| **High**     |   8   | IDOR, missing rate limits, public ID storage, consent gaps       |
| **Medium**   |  14   | Concurrency, validation, retry, audit, performance               |
| **Low/Info** |   7   | Code quality, dependencies, observability                        |

### Top 5 Must-Fix Items

1. **[SEC-001](#sec-001) — Admin API routes accept requests without verifying the caller is authenticated or holds the admin role.** Any actor who knows a route URL can read or mutate data.
2. **[SEC-002](#sec-002) — Public webhook endpoints have no signature verification.** Anyone can trigger deal activation or welcome-email blasts.
3. **[SEC-003 / CMP-001](#sec-003) — Government identification documents are uploaded to Vercel Blob with `access: "public"`.** The URLs are guessable-only by hash, not by access control — a PIPEDA red flag.
4. **[CMP-002](#cmp-002) — The intake flow collects extensive PII without an explicit consent checkpoint** (no privacy-policy acknowledgement, no stored consent timestamp).
5. **[CMP-003](#cmp-003) — Government IDs are forwarded to Google Gemini for classification** with no documented sub-processor disclosure or data-processing addendum.

### Overall Posture

> The platform is **functionally feature-rich** but requires **security and compliance hardening before broad rollout**. With ~2–4 weeks of focused remediation on the P0 items in §8, the platform can reach a defensible production baseline. The longer-tail items (§8 P1 and P2) bring it to a robust, audit-ready state.

---

## 2. Scope & Methodology

### What was reviewed

- `src/app/**` — all App Router pages and API routes
- `src/components/**` — UI components
- `src/lib/**` — business-logic helpers
- `src/services/**` — third-party integration wrappers
- `src/types/**` — TypeScript types
- `package.json`, `docs/schema.mmd`

### What was **not** reviewed

- Live Supabase Row-Level Security (RLS) policies (not visible from code)
- Vercel project settings, environment-variable management UI, deployment pipeline
- Sister application `iclosed_web` (client-facing front-end) — recommended for a separate review
- Runtime penetration testing or DAST — this is a **static code and architecture review**

### Severity definitions

| Severity     | Meaning                                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Direct compromise of confidentiality, integrity, or availability is possible without privileged access. Fix immediately. |
| **High**     | Realistic exploitation path or material compliance/business risk. Fix before next release.                             |
| **Medium**   | Meaningful weakness; fix within the next 30–60 days.                                                                   |
| **Low**      | Quality or hygiene concern; address opportunistically.                                                                 |
| **Info**     | Observation or recommendation with no immediate risk.                                                                  |

---

## 3. System Overview

### Tech Stack

| Layer              | Technology                          | Version       |
| ------------------ | ----------------------------------- | ------------- |
| Framework          | Next.js (App Router)                | 16.1.6        |
| UI                 | React + Tailwind CSS + daisyUI      | 19 / 3 / 3    |
| Database / auth    | Supabase                            | js client 2.98 |
| File storage       | Vercel Blob                         | 2.4           |
| Transactional mail | Resend                              | 6.9           |
| AI / OCR           | Google Gemini (`@google/genai`)     | 1.39          |
| Charting           | Recharts                            | 3.7           |
| CSV import         | PapaParse                           | 5.5           |

### High-level Architecture

```
                       ┌────────────────────────────────────────────────┐
                       │            iClosed Admin Portal                │
                       │            (Next.js App Router)                │
                       │                                                │
   Browser  ──────►  ┌──┴─ /admin/* pages ──┐    ┌── /api/admin/* ──┐  │
   (admin)           │   React components   │    │   Route handlers │  │
                     │   (Sidebar, Lists)   │◄───┤   (CRUD, files)  │──┼──► Supabase
                     └──────────────────────┘    └────────┬─────────┘  │     (auth + DB)
                                                          │            │
                                                          ├────────────┼──► Vercel Blob
                                                          │            │     (files)
                                                          ├────────────┼──► Resend
                                                          │            │     (email)
                                                          └────────────┼──► Google Gemini
                                                                       │     (ID OCR)
   External ──────► /api/webhooks/* ───────────────────────────────────┘
   systems          (new-lead, activate-deal)
```

The full ER diagram is maintained in [`docs/schema.mmd`](./schema.mmd) (Mermaid source) and rendered to [`docs/schema.svg`](./schema.svg) / [`docs/schema.png`](./schema.png).

### Key Flows

| Flow                     | Path                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Lead intake → conversion | `Intake.tsx` → `POST /api/webhooks/new-lead` → `POST /api/admin/convert-lead` → `convertLead.ts` → deal + family deals |
| Bulk import              | `BulkImport.tsx` → `POST /api/admin/bulk-import-deals/preview` → `POST /api/admin/bulk-import-deals`                   |
| Document upload          | `UploadIdentificationDrawer.tsx` → `POST /api/admin/uploadblobstorage` → Vercel Blob → `lead_corporate_docs`           |
| APS finalisation         | `POST /api/admin/deals/[id]/uploadblobstorage` → `completeApsTask.ts` → `recalcMilestones.ts`                          |
| Welcome email            | `convertLead` / `/api/admin/send-welcome-email` → `sendWelcomeEmail.ts` → Resend                                       |
| Impersonate              | `POST /api/admin/impersonate` → Supabase `auth.admin.generateLink`                                                    |
| ID classification        | `POST /api/admin/identify-document` → Google Gemini Vision                                                            |

---

## 4. Security Findings

Each finding follows this template:

> **\[ID] Title** — Severity
> **Location:** `path:line`
> **Description / Evidence / Impact / Recommendation**

### 4.1 Critical

<a id="sec-001"></a>
#### SEC-001 — Admin API routes accept requests without authentication or role check
**Severity:** Critical
**Location:** `src/app/api/admin/leads/route.ts:40-51`, `src/app/api/admin/deals/route.ts`, `src/app/api/admin/convert-lead/route.ts:18`, `src/app/api/admin/task-responses-batch/route.ts`, and ~20 sibling routes under `src/app/api/admin/*`.

**Description.** The vast majority of admin-facing API routes execute `supabaseAdmin` (service-role) queries without first verifying that the request carries a valid Supabase session or that the session belongs to a user with the `admin` role. A small subset (e.g. `account/update-email`) does extract and verify a Bearer token; this pattern is not generalised.

**Impact.** An unauthenticated attacker who discovers a route URL can list, create, update, or delete leads, deals, tasks, documents, and email templates. They can convert leads, send emails to clients on behalf of the platform, or impersonate any customer.

**Recommendation.**
1. Add `src/middleware.ts` that gates `/admin/**` and `/api/admin/**` routes — verifying a Supabase session cookie or `Authorization: Bearer <token>` header and the `app_metadata.role === "admin"` claim.
2. Provide a reusable `requireAdmin(req): Promise<User>` helper in `src/lib/` and call it at the top of every admin route handler. Return `401`/`403` early when the check fails.
3. Add an integration test that asserts an unauthenticated `fetch` against each `/api/admin/*` endpoint returns `401`.

---

<a id="sec-002"></a>
#### SEC-002 — Public webhook endpoints accept payloads without signature verification
**Severity:** Critical
**Location:** `src/app/api/webhooks/new-lead/route.ts`, `src/app/api/webhooks/activate-deal/route.ts`

**Description.** Both webhook endpoints accept arbitrary JSON bodies (`{ email, lead_id, client_id }`) and immediately mutate state — sending welcome emails or activating deals — with no HMAC signature, shared secret header, or IP allow-list.

**Impact.** Anyone with the public URL can (a) enumerate or harvest lead emails by triggering welcome-email blasts, (b) prematurely activate deals, or (c) cause spurious billing/email-cost spikes.

**Recommendation.** Adopt an HMAC-SHA-256 signature pattern. The calling system should sign the raw body with a shared secret (`WEBHOOK_SHARED_SECRET`); the route extracts the `X-iClosed-Signature` header and validates it via `crypto.timingSafeEqual`. Reject mismatches with `401`. Apply the same helper to all webhook routes.

---

<a id="sec-003"></a>
#### SEC-003 — Identification and APS documents stored on **public** Vercel Blob
**Severity:** Critical (also tracked as compliance issue [CMP-001](#cmp-001))
**Location:** `src/app/api/admin/uploadblobstorage/route.ts:31-38`

**Evidence.**
```ts
const blob = await put(
  `corporate-docs/${lead_id}/${Date.now()}-${file.name}`,
  file,
  { access: "public", ... }
);
```

**Description.** `access: "public"` makes every uploaded driver's licence, passport, SIN card, or Agreement of Purchase & Sale publicly readable by URL. Security relies entirely on URL guessability — there is no token, expiry, or access check on the file itself.

**Impact.** A single leaked URL (in a browser history, email, screenshot, log file, or referrer header) exposes the underlying document indefinitely. For Canadian client data this is also a PIPEDA exposure (§7 CMP-001).

**Recommendation.**
1. Switch all PII uploads to `access: "private"` (or `access: "token"` if `@vercel/blob` requires it).
2. Add a server-side proxy route `GET /api/admin/documents/[id]/download` that performs auth + access check, then streams the blob via a signed URL with short TTL.
3. Audit existing public blobs and migrate them to private storage; update DB rows with new private URLs.

### 4.2 High

<a id="sec-004"></a>
#### SEC-004 — IDOR on deal PATCH; no ownership check
**Severity:** High
**Location:** `src/app/api/admin/deals/[id]/route.ts:349-468`

**Description.** Once SEC-001 is fixed, any authenticated admin can still PATCH any deal by ID; there is no row-level check that the actor should have access to the targeted deal. If the customer model evolves to scope admins to specific brokers/teams, the current code provides no enforcement.

**Recommendation.** Add per-deal access control. Short-term: document the "all admins can edit all deals" assumption explicitly. Medium-term: enable Supabase RLS and rely on it as defence in depth, even when the route runs under the service-role key by reading via a user-scoped client first.

---

<a id="sec-005"></a>
#### SEC-005 — Blob URL allow-list uses bypassable `endsWith` check
**Severity:** High
**Location:** `src/app/api/admin/deals/[id]/uploadblobstorage/route.ts:62-76`

**Description.** The endpoint accepts a `fileUrl` from the client and validates it with `endsWith(".public.blob.vercel-storage.com")` against the hostname. A crafted URL such as `https://attacker.com/path?x=foo.public.blob.vercel-storage.com` (or a misuse of basic-auth syntax `https://api.public.blob.vercel-storage.com@attacker.com/`) can defeat naive string checks.

**Recommendation.** Use `new URL(fileUrl)` and assert `url.hostname.endsWith(".public.blob.vercel-storage.com")` (note: on the parsed `hostname`, not raw string). Better still: do not trust a client-supplied URL at all — issue an upload token that encodes `deal_id` (`token/route.ts` already exists) and reconcile the blob path server-side.

---

<a id="sec-006"></a>
#### SEC-006 — Impersonation route has no audit log and no second-factor gate
**Severity:** High
**Location:** `src/app/api/admin/impersonate/route.ts:39-57`

**Description.** Any admin can mint a magic-link for any customer via `auth.admin.generateLink`. There is no record of who initiated the impersonation, when, or why; no notification to the impersonated user; and no step-up authentication.

**Recommendation.** (1) Write an `audit_logs` row capturing actor email, target email/user id, timestamp, IP, and user-agent. (2) Email the customer when impersonation occurs. (3) Require a fresh password / 2FA confirmation on the admin side before issuing the link.

---

<a id="sec-007"></a>
#### SEC-007 — Password-reset endpoint has no rate limit
**Severity:** High
**Location:** `src/app/api/admin/reset-password/route.ts`

**Description.** The endpoint correctly returns a generic success message (good — prevents email enumeration via response delta), but does not throttle requests. A trivial loop can spam any inbox or burn Resend quota.

**Recommendation.** Add an in-memory or Redis-backed limiter keyed by `email` and by `IP` (e.g. 5/hour per email, 30/hour per IP). Reject excess attempts with the same generic success response so the limiter itself does not leak enumeration data.

---

<a id="sec-008"></a>
#### SEC-008 — Invitation token reusable for up to 7 days
**Severity:** High
**Location:** `src/lib/invitationToken.ts:76-89`

**Description.** Single-use enforcement is intentionally disabled to tolerate email-scanner pre-fetches (Microsoft SafeLinks, Gmail, etc.). The trade-off is reasonable, but no upper bound is placed on consumption count. A leaked token (forwarded email, log dump) can be replayed many times during its TTL window.

**Recommendation.** Track `consumption_count` and refuse the link after, e.g., 5 uses. Log each consumption with IP + UA. Consider a shorter TTL (24-72h) for high-sensitivity invitations.

---

<a id="sec-009"></a>
#### SEC-009 — Email template placeholder substitution allows reflective injection
**Severity:** High
**Location:** `src/lib/sendAuthEmail.ts:264-382`, `src/lib/sendWelcomeEmail.ts:103-186`

**Description.** Template bodies are stored in the `email_templates` DB table and rendered via successive `String.replaceAll` calls keyed on `{{ var.name }}` placeholders. If a user-controlled field (`lead.address_street`, `lead.notes`, etc.) contains a placeholder string like `{{ user.first_name }}`, subsequent passes will recursively substitute it. The fallback regex (`:379-382`) provides only partial coverage.

**Recommendation.** Use a proper templating engine (Handlebars / Nunjucks) with a sandboxed context. At minimum, perform a **single pass** over a precompiled token list — never re-scan output. HTML-escape every value before substitution; do not allow template authors to inject raw HTML from user data.

---

<a id="sec-010"></a>
#### SEC-010 — No security headers (CSP, HSTS, X-Frame-Options, etc.)
**Severity:** High
**Location:** No `src/middleware.ts` and no header config in `next.config.*`

**Description.** The platform serves admin tooling that handles PII, yet emits none of the standard hardening headers: no `Content-Security-Policy`, no `Strict-Transport-Security`, no `X-Frame-Options`, no `Referrer-Policy`, no `X-Content-Type-Options`.

**Recommendation.** Add the middleware suggested in SEC-001 and also use it (or `next.config.ts` `headers()`) to set:
- `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Content-Security-Policy: default-src 'self'; img-src 'self' https://*.blob.vercel-storage.com data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';` (refine after testing)
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

---

<a id="sec-011"></a>
#### SEC-011 — Gemini API key handled via raw env var with no per-user rate limit
**Severity:** High
**Location:** `src/services/geminiService.ts:10-14`, `src/app/api/admin/identify-document/route.ts:242-245`

**Description.** The Gemini key is read directly from `process.env`. The route imposes no per-admin or per-deal rate limit. A compromised admin session can incur unbounded API spend or be used to probe Gemini against externally supplied images.

**Recommendation.** (1) Rate-limit `/api/admin/identify-document` per actor (e.g. 30/hour). (2) Document a key-rotation schedule. (3) Where possible, use Google Cloud OAuth/service-account credentials instead of bare API keys; restrict the key by IP allow-list in Google Cloud Console.

### 4.3 Medium

| ID         | Title                                                                                                | Location                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **SEC-012** | Sensitive details echoed in API error messages (Resend errors, Supabase messages)                    | `src/lib/sendWelcomeEmail.ts:346`, `src/lib/sendAuthEmail.ts`                     |
| **SEC-013** | `.or()` filter built via string interpolation in deals fetch (defence-in-depth: validate UUIDs)      | `src/app/api/admin/deals/[id]/route.ts:86`                                        |
| **SEC-014** | Verbose `console.log` containing IDs and template mapping shipped to production                      | `src/app/api/admin/task-responses/route.ts:350-388`                               |
| **SEC-015** | `daisyui@^3.0.0` is an outdated major (current is 4.x); historical CSS-injection CVE class           | `package.json:16`                                                                 |
| **SEC-016** | `.env.local` hygiene: pre-commit hook / secret scanner not configured                                | repo root                                                                         |
| **SEC-017** | CORS configured only on `reset-password`; other public routes (webhooks) have no explicit CORS policy | `src/app/api/admin/reset-password/route.ts:4-20`                                  |
| **SEC-018** | Tailwind 3 + `@tailwindcss/postcss@4` co-installed — build fragility, possible CSS leakage           | `package.json`                                                                    |
| **SEC-019** | No automated dependency scanning (npm audit / Snyk / Dependabot) referenced in repo                  | repo root                                                                         |
| **SEC-020** | Service-role key cannot be guarded inside the bundle if a future `'use client'` accidentally imports `supabaseAdmin` | `src/lib/supabaseAdmin.ts`                                                       |
| **SEC-021** | File uploads not virus-scanned before becoming retrievable by other admins                           | `src/app/api/admin/uploadblobstorage/route.ts`                                    |
| **SEC-022** | Webhook payloads logged with PII (email addresses) in some routes                                    | `src/app/api/webhooks/new-lead/route.ts`                                          |
| **SEC-023** | Activate endpoint (`/api/auth/activate`) does not lock account on repeated invalid attempts          | `src/app/api/auth/activate/route.ts`                                              |
| **SEC-024** | Upload token (deal-scoped) has long TTL; reduce window                                               | `src/app/api/admin/deals/[id]/uploadblobstorage/token/route.ts`                   |
| **SEC-025** | No protection on `/api/admin/backfill-shared-tasks` — anyone can trigger heavy DB rewrites           | `src/app/api/admin/backfill-shared-tasks/route.ts`                                |

### 4.4 Low / Info

| ID         | Title                                                                                | Location                                |
| ---------- | ------------------------------------------------------------------------------------ | --------------------------------------- |
| **SEC-026** | Add `audit_logs` table — central recommendation surfacing in many findings           | DB schema                               |
| **SEC-027** | Document key-rotation cadence for Resend, Gemini, Supabase service-role              | runbook                                 |
| **SEC-028** | Add npm-audit / Snyk to CI                                                            | CI pipeline                             |

---

## 5. Missing Logic & Functional Gaps

Prefix: `GAP-`.

### 5.1 Data integrity & concurrency

<a id="gap-001"></a>
#### GAP-001 — No optimistic concurrency on deal PATCH (last-write-wins)
**Location:** `src/app/api/admin/deals/[id]/route.ts:349-468`
**Description.** When two admins open the same deal and save changes, the later request silently overwrites the first; neither user is informed of the conflict.
**Recommendation.** Require an `expected_updated_at` field in the PATCH body. Compare to the row's current `updated_at` inside the SQL update predicate; return `409 Conflict` (and the latest snapshot) when it does not match. Surface the conflict in the UI with a "review and re-save" flow.

<a id="gap-002"></a>
#### GAP-002 — Race condition in family-deal lookup on rapid conversions
**Location:** `src/lib/convertLead.ts:39-43`
**Description.** Two simultaneous `convert-lead` calls for the same lead read the table, both find no existing deal, and both insert one — producing duplicate deals and double-seeded shared tasks.
**Recommendation.** Add a partial unique index in Postgres (`UNIQUE (root_lead_id) WHERE deleted_at IS NULL`) and handle the constraint violation as "already exists; return the existing row." This eliminates the race without explicit locking.

<a id="gap-003"></a>
#### GAP-003 — Backfill endpoint has no idempotency guard
**Location:** `src/app/api/admin/backfill-shared-tasks/route.ts:36-41`
**Description.** A second invocation re-runs the migration over rows already updated. Without authentication (SEC-025) this is also externally triggerable.
**Recommendation.** Store a `migration_runs` row with a unique key per migration; refuse re-runs. Pair with the authentication fix from SEC-001.

<a id="gap-004"></a>
#### GAP-004 — Shared-task mirror creates duplicate rows on retry
**Location:** `src/app/api/admin/task-responses/route.ts:621-636`
**Description.** Network retries cause the same `task_response` to be inserted into every peer in the family. Doc counts inflate and the UI shows duplicate responses.
**Recommendation.** Use `UPSERT` (`ON CONFLICT (task_id, field_id, peer_lead_id) DO UPDATE`) and add the corresponding unique constraint.

<a id="gap-005"></a>
#### GAP-005 — Deal delete leaves orphan tasks, milestones, and documents
**Location:** `src/app/api/admin/deals/[id]/route.ts:471-487`
**Description.** `DELETE` on a deal does a simple row delete; child rows in `tasks`, `milestones`, `task_responses`, and `lead_corporate_docs` survive and appear in analytics, list pages, and storage costs.
**Recommendation.** Either declare `ON DELETE CASCADE` on the FK constraints, or delete dependents in a single transaction prior to deal removal.

<a id="gap-006"></a>
#### GAP-006 — Deal status transitions not validated
**Location:** `src/app/api/admin/deals/[id]/route.ts:313-317`
**Description.** Any status (`Active`, `Inactive`, `Closed`) can transition to any other, including resurrecting closed deals.
**Recommendation.** Encode the state machine: `Active ↔ Inactive`, both → `Closed` (terminal). Reject invalid transitions with `400`.

<a id="gap-007"></a>
#### GAP-007 — Task status changes do not always trigger milestone recalculation
**Location:** `src/app/api/admin/task-responses/route.ts:519-526`
**Description.** Several mutation paths complete or update tasks without invoking `recalcMilestonesForFamily`. Milestone state lags reality until an unrelated action recalculates it.
**Recommendation.** Centralise milestone recalculation behind a single helper called by every task-status-changing endpoint, or add a Postgres trigger.

### 5.2 Upload & blob lifecycle

<a id="gap-008"></a>
#### GAP-008 — Blob upload succeeds, DB insert fails → orphan bytes in Blob
**Location:** `src/app/api/admin/uploadblobstorage/route.ts:31-56`
**Description.** No compensating delete is issued if the `lead_corporate_docs` insert fails; orphan files accumulate in Vercel Blob and continue to incur storage cost.
**Recommendation.** Wrap in try/catch and `del()` the blob on DB failure. Add a nightly reconciliation job that lists Blob keys and deletes any not referenced in the DB.

<a id="gap-009"></a>
#### GAP-009 — No max file count, no file-size limit, no MIME allow-list
**Location:** `src/app/api/admin/uploadblobstorage/route.ts:31-56`
**Description.** A single deal can have unbounded uploads. There is no rejection of non-document MIME types or oversized payloads.
**Recommendation.** Cap files at e.g. 25 MB; allow only `image/jpeg`, `image/png`, `application/pdf`, `image/heic`. Enforce a per-task and per-deal upload count (e.g. 25 / 100).

<a id="gap-010"></a>
#### GAP-010 — APS replacement deletes family-wide rows without scope
**Location:** `src/app/api/admin/deals/[id]/uploadblobstorage/route.ts:163-167`
**Description.** Replacing an APS deletes prior `lead_corporate_docs` rows via an OR predicate spanning the family. Two co-purchasers uploading simultaneously can wipe each other's documents.
**Recommendation.** Scope the delete to the specific `(deal_id, doc_type, side)` tuple and run the delete + insert in a single transaction.

### 5.3 Email & notification

<a id="gap-011"></a>
#### GAP-011 — `welcome_email_sent` flag flipped after Resend call → duplicate sends possible
**Location:** `src/lib/sendWelcomeEmail.ts:351-358`
**Description.** If Resend succeeds but the subsequent `UPDATE welcome_email_sent` fails, the next call repeats the send. There is no idempotency key.
**Recommendation.** Flip the flag in the same transaction that originated the send intent, or pass an `Idempotency-Key` to Resend (supported by their API).

<a id="gap-012"></a>
#### GAP-012 — No retry on Resend transient failure
**Location:** `src/lib/sendWelcomeEmail.ts:337-347`
**Description.** A single failed call drops the email entirely. No queue, no dead-letter table.
**Recommendation.** Wrap sends in a 3-attempt exponential backoff; on final failure write a row to an `email_outbox` table for an out-of-band retry job.

<a id="gap-013"></a>
#### GAP-013 — HTML-entity decoding in email body is incomplete
**Location:** `src/lib/sendWelcomeEmail.ts:309-313`
**Description.** Only a handful of entities are decoded; others (`&amp;`, `&lt;`, `&#39;`, etc.) pass through and may render literally.
**Recommendation.** Use the `html-entities` package (~1 KB) or a single regex with the full entity table.

<a id="gap-014"></a>
#### GAP-014 — Milestone-email fetch failures silently swallowed
**Location:** `src/lib/recalcMilestones.ts:135-155`
**Description.** Per-deal errors inside the family loop are caught and discarded. A run can complete "successfully" while half the family never gets its email.
**Recommendation.** Aggregate per-deal errors and return them in the response; log at WARN with deal IDs.

### 5.4 Validation

| ID         | Issue                                                                                                                   | Location                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **GAP-015** | Bulk import has no file size / MIME validation                                                                          | `src/app/api/admin/bulk-import-deals/route.ts:31-37`                                      |
| **GAP-016** | Lead email accepted without regex / duplicate check                                                                     | `src/app/api/admin/leads/route.ts:55-105`                                                 |
| **GAP-017** | `file_number` regex inconsistent between bulk import (`/[0-9]{2}[A-Z]{1,3}-[0-9]{3,5}/`) and PATCH validation           | `src/lib/bulkImportValidation.ts:67` vs `src/app/api/admin/deals/[id]/route.ts:49`        |
| **GAP-018** | `field_type` accepted without enum check on task-response writes                                                        | `src/app/api/admin/task-responses/route.ts:572`                                           |

### 5.5 Auto-detection & edge cases

| ID         | Issue                                                                                                              | Location                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| **GAP-019** | `completeApsTask` auto-detect misses `doc_type='document'` rows whose `custom_type` says "APS"                     | `src/lib/completeApsTask.ts:100-104`              |
| **GAP-020** | `activateClientDeals` drops the OR filter for whichever ID is missing instead of using a fallback                  | `src/lib/activateClientDeals.ts:44-48`            |
| **GAP-021** | `recalcMilestones` keeps zero-task milestones in `Pending` forever — never transitions to `Not started`            | `src/lib/recalcMilestones.ts:95-107`              |

### 5.6 Testing

<a id="gap-022"></a>
#### GAP-022 — Zero automated tests in the repository
**Description.** No Jest, Vitest, Playwright, or Cypress configuration; no `*.test.ts` files. With a codebase of this complexity (family deals, milestone state machines, bulk imports), this materially raises regression risk and is consistent with the recent commit history dominated by bug-fixes.
**Recommendation.** Begin a test-pyramid build-up:
1. Unit tests for `recalcMilestones`, `convertLead`, `bulkImportValidation`, `completeApsTask`, `activateClientDeals`, `invitationToken`.
2. API integration tests with a Supabase test schema for the top-10 admin routes.
3. Playwright smoke for intake → conversion → first task completion.

---

## 6. Architecture & Code Quality

Prefix: `ARC-`.

### 6.1 API surface

<a id="arc-001"></a>
#### ARC-001 — No pagination on `/api/admin/deals` (entire table returned)
**Location:** `src/app/api/admin/deals/route.ts:11`
**Description.** The endpoint orders all deals by `created_at DESC` and returns every row. Payload grows linearly with the business and renders the list page progressively slower; eventually breaks the UI.
**Recommendation.** Switch to `range(offset, offset + page_size - 1)` with a `count: 'exact'` fetch for pagination metadata. Surface `page` / `pageSize` query params; render server-side pagination controls.

<a id="arc-002"></a>
#### ARC-002 — Unbounded `auth.admin.listUsers` loop
**Location:** `src/app/api/admin/deals/route.ts:32-53`
**Description.** Each list invocation iterates the entire Supabase auth user table in pages of 1000 to resolve a small number of `auth_user_id` references — an N+1 against the auth API as the customer base grows.
**Recommendation.** Cache `(auth_user_id → email, name)` in a Postgres view or materialised table refreshed on user upsert; resolve via a single `IN (...)` query.

<a id="arc-003"></a>
#### ARC-003 — `DealList.tsx` renders all rows without virtualization
**Recommendation.** Adopt `@tanstack/react-virtual` after ARC-001 is fixed; render only visible rows.

### 6.2 Code organisation

<a id="arc-004"></a>
#### ARC-004 — Duplicate routing tree
**Location:** `src/app/deals/*`, `src/app/leads/*`, `src/app/tasks/*`, `src/app/settings/*` all redirect to the matching `/admin/*` route.
**Recommendation.** Either delete the duplicate stubs and rely on `next.config.ts` `redirects()` for legacy URL handling, or commit to dual route trees and document why.

<a id="arc-005"></a>
#### ARC-005 — Client-side type mapping repeated across list and detail pages
**Location:** `src/components/DealList.tsx:44-82`, `src/app/deals/[id]/page.tsx:14-37`
**Recommendation.** Centralise in `src/lib/dealMapper.ts` with a single `toDeal(raw): Deal` function. Strongly type API responses with `Database['public']['Tables']['deals']['Row']` from `src/types/database.ts`.

<a id="arc-006"></a>
#### ARC-006 — Pervasive `any` in admin route handlers
**Location:** `src/app/api/admin/deals/route.ts:24-26,59,74,83-84` (representative)
**Recommendation.** Regenerate Supabase types via `supabase gen types typescript`. Replace `any` with the generated row/insert/update types.

<a id="arc-007"></a>
#### ARC-007 — Mixed Tailwind generations in `package.json`
**Location:** `package.json` — `tailwindcss@^3.4.19` (dev) co-installed with `@tailwindcss/postcss@^4` (dev).
**Recommendation.** Commit to one major. The Tailwind 3 → 4 migration is mostly non-breaking but requires explicit choice.

<a id="arc-008"></a>
#### ARC-008 — No global error boundary / fallback UI
**Location:** `src/app/ClientLayout.tsx`
**Recommendation.** Add an `ErrorBoundary` component wrapping the children; surface a graceful fallback with a "report issue" link. Add Next.js `error.tsx` files where applicable.

<a id="arc-009"></a>
#### ARC-009 — Inconsistent API error response schema
**Recommendation.** Adopt one shape across all routes: `{ ok: boolean; data?: T; error?: { code: string; message: string; details?: object } }`. Provide a `jsonError(code, message, status)` helper.

<a id="arc-010"></a>
#### ARC-010 — No `CLAUDE.md` / `README` / architecture brief
**Recommendation.** Add `CLAUDE.md` documenting: (1) high-level architecture, (2) auth flow, (3) family-deal model, (4) third-party integrations + DPA status, (5) compliance posture, (6) local dev setup, (7) seeded data fixtures.

<a id="arc-011"></a>
#### ARC-011 — Production console.log noise
**Location:** `src/app/api/admin/task-responses/route.ts:350-388`
**Recommendation.** Replace with a structured logger (Pino or a thin wrapper) gated by `process.env.LOG_LEVEL`. Strip identifiers from default INFO output.

<a id="arc-012"></a>
#### ARC-012 — Bug-fix-dominated recent git history signals regression risk
**Recommendation.** Pair the test scaffolding (GAP-022) with a release-gate convention: no PR merges to `main` without passing tests and a manual smoke checklist for the deal lifecycle.

---

## 7. Compliance & Data Protection

The platform operates in a Canadian real-estate context and handles PII including government identification documents. The applicable regimes are **PIPEDA** (personal information protection), **CASL** (commercial electronic messages), and provincial real-estate record-retention rules. Below are gaps relative to those expectations.

<a id="cmp-001"></a>
#### CMP-001 — Government-issued IDs stored on public-readable storage
**Severity:** High (also tracked as [SEC-003](#sec-003))
**Location:** `src/app/api/admin/uploadblobstorage/route.ts:31-38`
**PIPEDA Principle:** Safeguards (Principle 7).
**Recommendation.** See SEC-003. Until a fix ships, **stop uploading new ID documents to public Blob**; route ID intake to an interim private path.

<a id="cmp-002"></a>
#### CMP-002 — Intake collects PII without explicit consent capture
**Severity:** High
**Location:** `src/components/Intake.tsx`
**PIPEDA Principle:** Consent (Principle 3).
**Recommendation.** Add a final consent step before submission: a privacy-policy link, a checkbox the user must affirmatively tick, and a stored `privacy_consent_at` + `privacy_consent_version` per lead. The consent version lets you re-prompt when the policy changes.

<a id="cmp-003"></a>
#### CMP-003 — Identification documents forwarded to Google Gemini (US sub-processor)
**Severity:** High
**Location:** `src/app/api/admin/identify-document/route.ts:261-272`
**PIPEDA Principle:** Identifying Purposes (2), Limiting Use/Disclosure (5), Openness (8).
**Description.** The full ID image is sent to Google Gemini for classification. Google is a US-based processor; without a documented data-processing addendum (DPA) and explicit consumer disclosure, this is a PIPEDA gap.
**Recommendation.**
1. Disclose Gemini as a sub-processor in the public privacy policy.
2. Sign an enterprise DPA with Google Cloud (or migrate to Vertex AI in `northamerica-northeast1` for Canadian data residency).
3. Where possible, crop the document to its boundary and strip EXIF before transmission.

<a id="cmp-004"></a>
#### CMP-004 — No audit log of sensitive access
**Severity:** High
**Description.** PIPEDA's Accountability principle expects a demonstrable record of who accessed PII. The platform has no `audit_logs` table; impersonations, document accesses, ID classifications, and lead deletions are not recorded.
**Recommendation.** Introduce an `audit_logs` table `(id, actor_user_id, action, resource_type, resource_id, before, after, ip, user_agent, created_at)` and a `recordAudit()` helper invoked by impersonate, document download, lead/deal delete, ID classification, and bulk import.

<a id="cmp-005"></a>
#### CMP-005 — No data retention or right-to-be-forgotten flow
**Severity:** Medium
**Location:** `src/app/api/admin/leads/route.ts:40-45`
**Description.** Soft-delete (`is_deleted`) is supported, but soft-deleted leads are never purged, child documents persist forever, and there is no admin-side workflow to fulfil a "delete my data" request.
**Recommendation.** Publish a retention schedule (e.g. closed deals + 7 years for real-estate records). Provide a `POST /api/admin/leads/[id]/erase` route that hard-deletes the lead, its co-leads, documents, task responses, and Blob objects; record the deletion in `audit_logs` with a reason code.

<a id="cmp-006"></a>
#### CMP-006 — Transactional emails lack CASL-compliant unsubscribe
**Severity:** Medium
**Location:** `src/lib/sendWelcomeEmail.ts`
**Description.** All Canadian commercial electronic messages must carry a working unsubscribe link and a postal address. The current templates do not.
**Recommendation.** Add `{{ unsubscribe_link }}` and the sender's physical address to every template. Implement `/api/email/unsubscribe?token=…` and a `lead.email_opt_out` flag; honour the flag in `sendWelcomeEmail` / `sendAuthEmail`.

<a id="cmp-007"></a>
#### CMP-007 — No HSTS / CSP / security headers
**Severity:** Medium
**Description.** Duplicates [SEC-010](#sec-010); tracked here for compliance completeness.

<a id="cmp-008"></a>
#### CMP-008 — PII leakage via error responses and server logs
**Severity:** Medium
**Location:** `src/lib/sendWelcomeEmail.ts:346`, `src/lib/sendAuthEmail.ts`, `task-responses/route.ts:350-388`
**Recommendation.** Return generic error codes/messages to the client; log full detail server-side only, with PII redaction in the logger.

---

## 8. Prioritised Remediation Roadmap

| Phase                                  | Timeframe        | Items                                                                                                                                 | Outcome                                              |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **P0 — Block before broad rollout**    | Now → 2 weeks    | SEC-001 (auth middleware), SEC-002 (webhook HMAC), SEC-003 / CMP-001 (private Blob + download proxy), CMP-002 (consent), CMP-003 (DPA + disclosure) | Auth & data-protection baseline                       |
| **P1 — Stabilise within 30 days**      | 2 → 6 weeks      | All remaining High items (SEC-004 → SEC-011), GAP-001 (optimistic lock), GAP-008 (orphan blob), GAP-010 (APS scoping), CMP-004 (audit log), CMP-006 (CASL unsubscribe), CMP-007 (security headers), ARC-001 (pagination), ARC-002 (auth lookup cache) | Operational resilience and compliance posture       |
| **P2 — Hardening & long-term quality** | 6 → 12 weeks     | All Medium SEC + remaining GAP + ARC items, full test scaffolding (GAP-022), `CLAUDE.md` (ARC-010), Tailwind alignment, structured logging   | Maintainability, audit-readiness, low regression risk |

The roadmap intentionally front-loads items that affect production data protection and that are visible to clients, regulators, or both.

---

## 9. Recommendations Checklist (one-page summary)

Authentication & API hardening
- [ ] Add `src/middleware.ts` enforcing auth + role gate on `/admin/**` and `/api/admin/**`
- [ ] Create `requireAdmin(req)` and apply to every admin route handler
- [ ] HMAC signature verification helper for `/api/webhooks/*`
- [ ] Per-actor rate limits on password-reset, identify-document, and impersonate routes
- [ ] Step-up authentication / mandatory audit row on impersonate

File & document protection
- [ ] Migrate Vercel Blob from `access: "public"` to private + signed-URL proxy route
- [ ] Add file size, MIME, and per-deal upload-count limits
- [ ] Compensating delete on DB-insert failure; nightly orphan-blob reconciliation
- [ ] Scope APS replacement deletes to `(deal_id, side)`

Data integrity
- [ ] Optimistic locking on deal PATCH (`expected_updated_at`)
- [ ] Partial unique index on `convertLead` family-deal lookup
- [ ] Cascade deletes for `tasks`, `milestones`, `task_responses`, `lead_corporate_docs`
- [ ] State-machine validation for deal status transitions
- [ ] Central milestone-recalculation helper invoked on every task-mutating route
- [ ] UPSERT on shared-task mirror with unique constraint

Email & notifications
- [ ] Add `email_outbox` retry queue; exponential backoff on Resend
- [ ] Idempotency keys for transactional sends; flip `welcome_email_sent` before send
- [ ] Replace `replaceAll` template substitution with sandboxed templating + HTML escape
- [ ] CASL `{{ unsubscribe_link }}` + sender postal address in all templates

Compliance & privacy
- [ ] Privacy-consent capture + `privacy_consent_at` / `privacy_consent_version` on leads
- [ ] `audit_logs` table + `recordAudit()` helper
- [ ] Right-to-be-forgotten endpoint with cascade purge
- [ ] Documented retention schedule + scheduled purge job
- [ ] Public privacy policy + Google DPA for Gemini sub-processing; consider Vertex AI in `northamerica-northeast1`

Architecture & quality
- [ ] Pagination + virtualization on deal list; cache auth-user lookups
- [ ] Replace `any` types with generated Supabase types
- [ ] Central deal mapper in `src/lib/dealMapper.ts`
- [ ] Remove duplicate `/app/deals` etc. stubs (or document them)
- [ ] Standardise API error response schema
- [ ] Tailwind major-version alignment
- [ ] Global error boundary + Next.js `error.tsx` files
- [ ] Structured logger gated by `LOG_LEVEL`

Process & documentation
- [ ] `CLAUDE.md` covering architecture, flows, integrations, compliance
- [ ] Jest/Vitest unit tests for the six core lib helpers
- [ ] Playwright smoke for intake → conversion → first-task happy path
- [ ] CI: lint, type-check, npm-audit, test, build on every PR
- [ ] Dependabot / Renovate for dependency hygiene
- [ ] Secret scanning + pre-commit hook to prevent `.env.local` commits

---

## 10. Appendix

### A. Severity definitions

See §2.

### B. File index

| File                                                                                | Finding IDs                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `src/app/api/admin/leads/route.ts`                                                  | SEC-001, GAP-016                                           |
| `src/app/api/admin/deals/route.ts`                                                  | SEC-001, ARC-001, ARC-002, ARC-006                         |
| `src/app/api/admin/deals/[id]/route.ts`                                             | SEC-001, SEC-004, SEC-013, GAP-001, GAP-005, GAP-006       |
| `src/app/api/admin/deals/[id]/uploadblobstorage/route.ts`                           | SEC-005, GAP-010                                           |
| `src/app/api/admin/deals/[id]/uploadblobstorage/token/route.ts`                     | SEC-024                                                    |
| `src/app/api/admin/uploadblobstorage/route.ts`                                      | SEC-003 / CMP-001, GAP-008, GAP-009, SEC-021               |
| `src/app/api/admin/identify-document/route.ts`                                      | SEC-011, CMP-003                                           |
| `src/app/api/admin/impersonate/route.ts`                                            | SEC-006                                                    |
| `src/app/api/admin/reset-password/route.ts`                                         | SEC-007, SEC-017                                           |
| `src/app/api/admin/convert-lead/route.ts`                                           | SEC-001                                                    |
| `src/app/api/admin/backfill-shared-tasks/route.ts`                                  | SEC-025, GAP-003                                           |
| `src/app/api/admin/task-responses/route.ts`                                         | SEC-014, GAP-004, GAP-007, GAP-018, CMP-008                |
| `src/app/api/webhooks/new-lead/route.ts`                                            | SEC-002, SEC-022                                           |
| `src/app/api/webhooks/activate-deal/route.ts`                                       | SEC-002                                                    |
| `src/app/api/auth/activate/route.ts`                                                | SEC-023                                                    |
| `src/app/api/admin/bulk-import-deals/route.ts`                                      | GAP-015                                                    |
| `src/lib/invitationToken.ts`                                                        | SEC-008                                                    |
| `src/lib/sendWelcomeEmail.ts`                                                       | SEC-012, GAP-011, GAP-012, GAP-013, CMP-006, CMP-008       |
| `src/lib/sendAuthEmail.ts`                                                          | SEC-009, SEC-012, CMP-008                                  |
| `src/lib/recalcMilestones.ts`                                                       | GAP-014, GAP-021                                           |
| `src/lib/convertLead.ts`                                                            | GAP-002                                                    |
| `src/lib/completeApsTask.ts`                                                        | GAP-019                                                    |
| `src/lib/activateClientDeals.ts`                                                    | GAP-020                                                    |
| `src/lib/bulkImportValidation.ts`                                                   | GAP-017                                                    |
| `src/lib/supabaseAdmin.ts`                                                          | SEC-020                                                    |
| `src/components/Intake.tsx`                                                         | CMP-002                                                    |
| `src/components/DealList.tsx`                                                       | ARC-003, ARC-005                                           |
| `src/app/ClientLayout.tsx`                                                          | ARC-008                                                    |
| `src/services/geminiService.ts`                                                     | SEC-011                                                    |
| `package.json`                                                                      | SEC-015, SEC-018, ARC-007                                  |
| (repo root)                                                                         | SEC-010 / CMP-007, SEC-016, SEC-019, SEC-026, ARC-010, ARC-012, GAP-022 |

### C. Glossary

| Term       | Meaning                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------ |
| **APS**    | Agreement of Purchase and Sale — the core real-estate transaction document.                            |
| **PIPEDA** | Personal Information Protection and Electronic Documents Act (Canadian federal privacy law).           |
| **CASL**   | Canada's Anti-Spam Legislation — governs commercial electronic messages.                              |
| **RLS**    | Row-Level Security — Postgres/Supabase policy mechanism enforced at the database layer.               |
| **IDOR**   | Insecure Direct Object Reference — accessing or modifying resources by guessing identifiers.           |
| **HMAC**   | Hash-based Message Authentication Code — cryptographic signature with a shared secret.                |
| **RTBF**   | Right To Be Forgotten — a data subject's right to erasure of their personal information.              |
| **DPA**    | Data Processing Addendum — contractual addendum governing a sub-processor's handling of personal data. |

### D. References

- Database schema: [`docs/schema.mmd`](./schema.mmd) (Mermaid source), [`docs/schema.svg`](./schema.svg), [`docs/schema.png`](./schema.png)
- Prior security audit (out-of-scope here, separately maintained): `docs/iClosed-Security-Architecture-Audit-2026-05-29.*`

---

*End of document. Total findings: 47 (Critical: 3, High: 8, Medium: 14, Low/Info: 22 across SEC/GAP/ARC/CMP).*
