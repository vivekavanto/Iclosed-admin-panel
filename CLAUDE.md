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
  Supabase session cookie via `getUser()` and checks the central policy in
  `src/lib/staffAccess.ts`. Verified company-domain staff can sign in, but new
  accounts receive no modules. The verified `saru@navawilson.law` account owns
  access management at `/admin/access`; only server-owned `app_metadata` grants
  modules. Existing legacy admins retain modules until explicitly scoped. See
  `docs/staff-access.md` for module boundaries and deployment requirements.
- **Exceptions:** `PUBLIC_ADMIN_API` in `middleware.ts` lists a few routes called
  by external systems / the portal (reset-password, send-*). Those are protected
  instead by HMAC signatures — see `src/lib/verifyServiceSignature.ts` (verify
  side) and the portal's `signServiceRequest.ts` (sign side).
- Routes OUTSIDE `/api/admin` are public by construction (the matcher never runs
  on them) and carry their own token: `/api/auth/activate` (invite/recovery
  only) and `/api/final-report/download` (an `invitation_tokens` row of type
  `final_report`, scoped to specific document ids).
- `supabaseAdmin` (`src/lib/supabaseAdmin.ts`) is the **service-role** client — it
  bypasses RLS and must NEVER be imported into client code (guarded to throw in
  the browser).
- **Access model:** module permissions now apply to pages and APIs. Connected
  file modules share backing APIs; this is not per-deal or per-team scoping.
  Per-deal authorization and database RLS remain separate work. Owner-only
  operations include account management and unclassified maintenance APIs.

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

## Firms (Nava Wilson vs iClosed LLP)

Clients are served under two entities, recorded per file on `leads.firm_key`
(`navawilson` | `iclosed`). **New files default to `iclosed`** since
2026-09-08; files created before that keep `navawilson` — the default was never
backfilled, because re-branding a live file is a business decision. Two places
hold that default and must move together: the column DEFAULT (the portal's
intake insert names no firm, so it is what actually stamps a new file) and
`DEFAULT_FIRM_KEY` in `firms.ts` (unrecognised values and failed lookups only).
An admin flips a file on the lead detail page or from the Firm column on the
leads list; the PUT handler cascades it to every co-lead, and
`src/lib/leadFirm.ts` resolves it from the **root** lead so a family can never be
branded two ways.

The label drives three client-visible things:

| What | Where |
| --- | --- |
| Sender / reply-to | `emailFrom(firm)` / `emailReplyTo(firm)` in `emailIdentity.ts` |
| Email lockup | `brandEmailHtml(html, firm)` — rewrites the logo filename in the rendered body (`emailBrand.ts`) |
| Retainer logo + wording | **portal** repo: `firms.ts`, `retainerFaq.ts`, `generateRetainerPdf.ts` |

`src/lib/firms.ts` is the registry and is **mirrored** in the portal
(`iclosed_dev_web/src/lib/firms.ts`); the keys match
`closing_cost_config.firm_key`, which has been per-firm since 2026-08-03.

Internal/staff mail (`notifyAllTasksComplete`, `sendClerkDocumentsEmail`) and
file-less mail (`sendPartnerCodeEmail`, the public calculator) stay on the
firm-agnostic sender on purpose.

## Partner referral codes

`partners.referral_code` is **first name + the initial of the SECOND name + the
year** — `Sarujan Kana` → `SARUJANK2026`, `Aliya Ali Shaikha` → `ALIYAA2026`
(the second token, not the last). A clash takes one more letter of the second
name, first come first served: `Raninder Khal` → `RANINDERK2026`, so a later
`Raninder Khali` → `RANINDERKH2026`. A code is written once at creation and is
never recomputed.

`src/lib/referralCode.ts` owns the rule and is **mirrored** in the portal
(`iclosed_dev_web/src/lib/referralCode.ts`), because intake find-or-creates a
partner for a keyed-in agent (`resolvePartner.ts`) against the same table — both
must mint identical codes. The year is a constant, not `getFullYear()`; moving
to a new cohort means editing both copies. The old scheme (name prefix + global
sequence, `SARUJAN0001`) was rewritten in place by
`migrations/2026-09-17-referral-codes-2026.sql`, which is **not** reversible —
codes clients already hold stopped validating.

## Key flows

| Flow | Path |
| --- | --- |
| Intake → conversion | portal `Intake` → `POST /api/intake` (portal) → admin `convert-lead` → `convertLead.ts` → deal + family deals |
| Document upload (admin) | `UploadIdentificationDrawer` → `POST /api/admin/uploadblobstorage` → Vercel Blob → `lead_corporate_docs` |
| APS finalisation | client upload via token → `POST /api/admin/deals/[id]/uploadblobstorage` → `completeApsTask.ts` → `recalcMilestones.ts` |
| Welcome / auth / agent email | `sendWelcomeEmail.ts` / `sendAuthEmail.ts` / `sendAgentSignupEmail.ts` → Resend (templates rendered via `renderEmailTemplate.ts`) |
| Final report delivery | `PostClosureDocuments` → upload (30 MB cap, `doc_type=final_report`) → `POST .../final-report/email` → `sendFinalReportEmail.ts` mints a per-group token (`finalReportLink.ts`) → client opens `GET /api/final-report/download` (public, token-scoped). Never an attachment |
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
- `RESEND_WEBHOOK_SECRET` — Resend webhook signing secret (`whsec_…`); when set,
  the inbound-email route requires a valid Svix signature (see
  `docs/client-messaging.md`)
- `RESEND_FROM_EMAIL_NAVAWILSON` / `RESEND_FROM_EMAIL_ICLOSED` (+ the matching
  `RESEND_REPLY_TO_EMAIL_*`) — per-firm sender overrides; see "Firms" below.
  The legacy firm-agnostic `RESEND_FROM_EMAIL` no longer applies to
  file-scoped mail
- `AGENT_CC_ALWAYS` — comma-separated staff CC'd on every agent-facing email
  (defaults to `saru@iclosed.ca` in `agentCc.ts`; set it to the empty string to
  turn the standing CC off without a deploy)
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

`migrations/` is **gitignored** since 2026-09-17, so a NEW migration is never
pushed — it lives only on the machine that wrote it. The 102 files committed
before that date are still tracked (a `.gitignore` rule does not untrack what git
already follows). Two consequences to work around: a new migration cannot be
reviewed in a PR, and a fresh clone cannot reconstruct the schema from the repo,
so the SQL has to reach whoever applies it by another route.

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
