# Legal Assistant dev promotion

Status: prepared for review and integration testing; NOT activated on devadmin.iclosed.ca.

## Source baseline and conflicts

Promotion starts at dev `241c57a`, with module changes from tested local `24ac75d`. Do not merge the old recovery branch wholesale: its divergent history predates dev's staff permissions, Agent Portal, messages and signing changes. This branch retains dev's middleware, login, layout, staff access and all existing Vercel crons. It adds the missing machine refresh handler without removing other schedules.

Two existing dev issues were resolved during validation: Leads imported Node crypto through its eligibility helper (now a separate browser-safe module), and a stale letterhead test expected the same address despite the intentional iClosed Suite 209 change. No firm address was changed.

## Runtime layout

- Vercel continues serving the existing authenticated Admin site and module APIs. The normal Admin Supabase settings continue authenticating staff.
- The verified **iclosed-dev Supabase project** holds revisioned private documents and a private content-addressed artifact bucket. The namespace is explicitly dev-only. Browser/anon/authenticated users have no table access. Server and worker credentials stay private.
- Audits, register/import history, verified folders, feedback, OAuth attempts/connections, mortgage test receipts, COO revisions/receipts and opening requests use durable cloud state. Register mutation reuses the tested reconciliation logic with database compare-and-swap and saved-row/receipt readback. Unchanged business rows retain their prior contents and source timestamps. Document envelopes preserve serialized key order and verify a checksum, keeping existing revision hashes stable through JSONB storage. Missing baseline/schema/connection fails closed; it cannot initialize a replacement register.
- Two supervised deterministic worker services run `worker.mjs --role=operations` and `worker.mjs --role=audits`. They can run on the existing Mac mini after native dependency verification. They expose no incoming port and poll the private database. COO rendering, registered-deed inspection and condo-contact inspection are offloaded from Vercel. Audit jobs already use separately leased claims. Roles have independent heartbeats, so a long audit does not prevent COO processing. Native PDF and scanned-page OCR smoke tests must pass before a worker publishes its heartbeat.
- A discovery-only service checks Gmail every two minutes using `discovery.mjs`, with a shared lease and fenced checkpoint writes. It never invokes a model. Hosted email-to-model extraction remains disabled under the existing separate activation gate. Opening execution retains the existing Tickler/numbering/Drive/Closer blockers; approved cards never claim external files were created.
- `daily-sync.mjs` runs under a service manager, checks after 02:30 Toronto time, and retries unresolved fresh-extract checks every five minutes. It reuses full-coverage selection, checksum deduplication, revision locks and saved receipt readback. Vercel Preview does not execute production cron schedules. The local daily-sync service remains unchanged until a separately verified cutover.

## Environment changes

The exact variable names are in `scripts/legal-assistant-hosted/environment.example`. It contains no secret values. Configure values only for this project's **Preview / dev branch**, preserving Production and unrelated preview overrides. Worker processes receive their own private environment file, not the web application's complete environment.

Keep the Admin authentication Supabase variables. Add explicit workflow URL/key settings for the verified dev project and its private tables. Never copy `ORCHESTRATOR_LOCAL_STATE_DIR`, Mac paths or a complete local `.env.local` into Vercel. Set the stable 32-byte token encryption key identically on web/worker; rotate through a reviewed re-encryption procedure, not replacement during every deploy. Model API keys and native PDF/OCR paths belong only on workers. Web receives the model selection and submission flag.

The existing Gmail OAuth web client needs the HTTPS callback `https://devadmin.iclosed.ca/api/admin/legal-assistant/mailbox/callback` registered while retaining existing callbacks. Read-only mailbox and sending scopes/connections remain separate. Existing authorized refresh tokens can be re-encrypted during transfer only for the identical OAuth client and mailbox; changed client IDs require explicit reconnection.

Sensitive Vercel settings are unreadable after creation and can appear blank in `env pull`. Blank downloads are not proof of a missing deployed value. Do not overwrite existing settings using those blanks.

## Reviewed deployment sequence

1. Confirmed existing `iclosed-dev` (awygszzpyotaddnspikt), Canada Central; production is the separate `iclosed` project. Reuse dev, with additive private workflow tables and namespace; no new paid project or role change is needed. CLI management sign-in is now available.
2. Review and manually apply `docs/legal-assistant-schema/2026-10-27-hosted-documents.sql` to that project. It creates only the private document table and service-role-only CAS function. Do not apply the older register RPC schemas: hosted mode preserves the full approved register document directly.
3. Create a **private** bucket with the configured name and appropriate file-size/quota limits. No public policies, anonymous reads or public URLs. Service-role storage requests provide artifact readback and checksum verification. Set retention/backup requirements before activation.
4. Quiesce local writers and finish active audit jobs/sends. Preserve the current local state and receipts. Produce an owner-only plan (read-only by default):

   `node --experimental-strip-types scripts/legal-assistant-hosted/transfer.mjs --source <canonical-private-state> --source-env <private-source-env> --manifest <private-manifest.json>`

   Review its identity-free counts and SHA-256. Transfer only with the exact reviewed hash, the verified dev target private environment and `--apply --expected-manifest <hash>`. No source files are removed. Existing different target records abort rather than overwrite. Partial identical transfers are resumable. Missing frozen artifacts, active sends, changed source bytes or failed readback prevent publication of the activation receipt. OAuth envelopes are re-encrypted; pending OAuth attempts are not copied. Derived inspection caches are rebuilt by the worker.
5. Populate dev-branch-only web secrets/settings; distribute scoped worker configuration privately. Set `ORCHESTRATOR_BASELINE_SHA256` to the verified transfer receipt. Hosted state reads/transactions require that matching receipt. Enroll the two worker roles plus discovery and daily sync as durable services, using Node 24+ with `--experimental-strip-types`. Run native preflight and one-shot service checks before enabling audit submissions/imports.
6. Verify SQL privileges/RLS and private bucket denial for anon/authenticated identities; concurrent claims/CAS against the actual database; migration row/receipt/blob hashes; OAuth identity/read scopes; both worker roles and restart/expired-lease behavior; a synthetic COO PDF and internal email test; an audit with scanned-page coverage; and a fresh-extract import plus duplicate retry. Email/COO tests use the explicitly approved internal mailbox only. No client notices or external opening execution during deployment checks.
7. Deploy the exact reviewed commit to dev and verify actual signed-in routes, register counts, saved reports, feedback, Settings, file-opening requests and worker status through devadmin. Only then report promotion complete. Retain the prior deployment and frozen source backup for rollback; reconcile any hosted receipts before resuming old local writers. Code rollback must never rewind sent-mail or import records.

## Limits requiring acceptance before rollout

The deployment scripts are prepared; native runner smoke tests passed, while cloud integration checks remain pending. SQL execution, full baseline transfer, Vercel secret updates, service enrollment and signed-in dev workflow checks remain open. Large COO responses must be tested against the hosting response-size limit; move packet download to authenticated private-object delivery if representative packets exceed it. Native worker dependency versions and OCR quality must be verified on the actual selected runner. A code build or mocked database test does not complete these gates.

## Runner preparation verified October 27

An isolated runner was prepared on the existing Mac mini at `~/Library/Application Support/iClosed/LegalAssistant/HostedDevWorker`. It uses its existing Node 26.10.0, isolated managed Python 3.13.11, pinned PDF dependencies and a compiled copy of the repository OCR helper. Both native pages rendered and the scanned page's synthetic text was recognized. The Closer environment was unchanged. Worker source/dependencies are present; no secrets, client data, launch services or incoming listener were installed. Enroll only after the hosted baseline and configuration have been verified. Copy `worker-package.json` and `worker-package-lock.json` as the runner's package manifests; use `npm ci --ignore-scripts` to reproduce Node dependencies. The native preparation script uses `requirements.lock`.

The read-only source transfer plan found revision 52 with 67 matters, 78 frozen artifacts, two COO revisions and two saved mailbox connections. This is an inventory, not a hosted transfer or a database success claim. The private manifest is not committed and must be regenerated if source bytes change.

## Current activation gate

Automatic approval review rejected applying the additive schema/privilege migration to the shared `iclosed-dev` database because the retained repository instructions require a separate reviewed deployment gate. No schema migration ran. The owner-only pending environment configuration is staged locally with audit submissions/imports/sending disabled; it has not been applied to Vercel or distributed to running services. The reviewed rollout must cover the SQL, private bucket, verified baseline transfer, dev-only environment settings and worker enrollment before the alias is promoted. Production and existing local workflows remain unchanged.

## Final verification findings

- Full repository checks now pass 479 tests; the production build, TypeScript and scoped lint pass. Full lint's two imported fixture errors were corrected; remaining warnings are non-blocking.
- Signed-in local verification uncovered a real discovery stall: one added message had been deleted before retrieval. Discovery now recovers remaining thread content where possible, records unavailable-message coverage explicitly and prevents approval from surviving an unverifiable existing source. The isolated fix was backported and committed to the active local app; discovery resumed with zero model calls, preserved its queue and displayed its coverage gap on the signed-in screen. The source manifest must be regenerated after quiescing writers for transfer.
- Vercel blocked the draft branch's automatic previews because it could not find a Git account for the commit author. This is separate from the reviewed schema gate. Resolve deployment through an existing linked operator account after approval; do not add paid members, rewrite contributor identity or weaken project permissions. The dev alias has not changed.
