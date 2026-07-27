# iClosed Admin Portal — Architecture & Working Notes

Internal admin app for a Canadian real-estate transaction workflow: lead intake →
conversion → deal management → tasks/milestones → document collection → client
communication.

There is a **sister repo**, `iclosed_dev_web` (the customer portal), that shares
the **same Supabase database and Vercel Blob store**. Changes to shared data
(leads, deals, documents, consent) often need to be made in both. This doc covers
the admin repo but flags the portal where it matters.

## Stack

| Layer | Tech |
| --- | --- |
| Framework | Next.js 16 (App Router), React 19 |
| UI | Tailwind CSS + daisyUI |
| DB / auth | Supabase (Postgres + Auth) |
| File storage | Vercel Blob (`@vercel/blob`) |
| Transactional email | Resend |
| AI / OCR | Google Gemini (ID document classification) |

## Auth model

- `src/middleware.ts` gates `/admin/**` and `/api/admin/**`: it validates the
  Supabase session cookie via `getUser()` and requires
  `app_metadata.role === "admin"`. Everything under `/api/admin/*` therefore runs
  only for authenticated admins.
- **Exceptions:** `PUBLIC_ADMIN_API` in `middleware.ts` lists a few routes called
  by external systems / the portal (reset-password, send-*). Those are protected
  instead by HMAC signatures — see `src/lib/verifyServiceSignature.ts` (verify
  side) and the portal's `signServiceRequest.ts` (sign side).
- `supabaseAdmin` (`src/lib/supabaseAdmin.ts`) is the **service-role** client — it
  bypasses RLS and must NEVER be imported into client code (guarded to throw in
  the browser).
- **Access model (SEC-004, accepted decision):** every authenticated admin can
  see and edit **every** deal/lead — there is intentionally NO per-deal or
  per-team scoping. All admins are trusted staff. If teams/brokers who should
  only see their own files are ever introduced, per-deal authorization must be
  added (and Supabase RLS enabled as defence in depth).

## The family-deal model (important)

A single real-estate "file" can involve several people:

- **`leads`** — one row per person. Co-purchasers / co-sellers are separate lead
  rows linked by `parent_lead_id` (the primary lead is the "root"; children point
  at it). `co_person_role` distinguishes co-purchaser (Purchase side) vs co-seller
  (Sale side).
- **`deals`** — one per lead (`deals.lead_id`), sharing one `file_number` across
  the family. `client_id` links to the `clients` record (the portal login).
- **`tasks`** / **`milestones`** — per deal (`deal_id`). Some tasks are **shared**
  (`is_shared`): a response on one is mirrored to the same task across every deal
  in the family (`findFamilySharedTaskPeers`, `task-responses` route).
- **`lead_corporate_docs`** / **`lead_identification_docs`** — uploaded documents,
  keyed by `lead_id`, with `file_url` pointing at Vercel Blob.
- Milestone status is **derived from its tasks** (`recalcMilestones.ts`), not set
  directly. Personal fields (marital status, citizenship, etc.) live on
  **`clients`**, overlaid onto leads at read time.

## Key flows

| Flow | Path |
| --- | --- |
| Intake → conversion | portal `Intake` → `POST /api/intake` (portal) → admin `convert-lead` → `convertLead.ts` → deal + family deals |
| Document upload (admin) | `UploadIdentificationDrawer` → `POST /api/admin/uploadblobstorage` → Vercel Blob → `lead_corporate_docs` |
| APS finalisation | client upload via token → `POST /api/admin/deals/[id]/uploadblobstorage` → `completeApsTask.ts` → `recalcMilestones.ts` |
| Welcome / auth / agent email | `sendWelcomeEmail.ts` / `sendAuthEmail.ts` / `sendAgentSignupEmail.ts` → Resend (templates rendered via `renderEmailTemplate.ts`) |
| Impersonate | `POST /api/admin/impersonate` → Supabase `auth.admin.generateLink` (audited) |
| ID classification | `POST /api/admin/identify-document` → Google Gemini |

## Third-party integrations & env

Secrets live only in Vercel env (never in the repo; `.env*` is gitignored).
Rotation cadence is in `docs/key-rotation.md`.

- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `BLOB_READ_WRITE_TOKEN`
- `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- `GEMINI_API_KEY`
- `SERVICE_WEBHOOK_SECRET` (+ `SERVICE_WEBHOOK_ENFORCE`) — shared with the portal
- `NEXT_PUBLIC_PRIVATE_BLOB` — flag that switches document storage to private
  (requires a private-capable Blob store; see the remediation tracker)

## Security & compliance posture

The review and remediation status live in
`docs/iClosed-Security-Remediation-Tracker.md` (and a spreadsheet
`docs/iClosed-Security-Status.xlsx`). Notable pieces already in place:

- Admin auth middleware; UUID validation on id route params; upload
  size/type validation (`uploadValidation.ts`) with orphan-blob cleanup.
- Audit logging (`recordAudit.ts` → `audit_logs`) on impersonation and deletes.
- Privacy consent capture at intake; right-to-be-forgotten erase endpoint
  (`/api/admin/leads/[id]/erase`).
- Single-pass, HTML-escaped email template rendering (`renderEmailTemplate.ts`).
- Security headers in `next.config.ts` (CSP currently report-only).
- CI: lint/type-check/build + npm-audit + gitleaks in `.github/workflows`.

## Migrations

Plain SQL files in `migrations/` (named `YYYY-MM-DD-description.sql`), applied
manually via the Supabase SQL editor. They are NOT auto-run — after adding one,
run it before deploying code that depends on it.

## Local dev

- `npm run dev` (or `pnpm dev`) — Next dev server on :3000.
- `npm run build`, `npm run lint`, `npx tsc --noEmit` for type-check.
- `.env.local` holds secrets locally (gitignored). `NEXT_PUBLIC_*` values are
  inlined at build/startup — restart the dev server after changing them.

## Conventions

- Prefer the shared helpers: `isUuid`, `recordAudit` + `getActingAdmin`,
  `renderTemplateSafe`, `validateUpload`, `FILE_NUMBER_REGEX`, `blobPrivacy`
  helpers, `migrationRun`, and `logger` (gated by `LOG_LEVEL`) instead of bare
  `console.*` — new code should use `logger`.
- Server routes return `{ success, error }` (or `{ error }`) JSON. Keep internal
  error detail in server logs, not client responses, for public routes.
- Blob URLs are self-describing: `<store>.public.` vs `<store>.private.`;
  `docDownloadHref()` proxies private ones through an auth-gated route.
