# Legal Assistant dev promotion

Status: owner-approved dev deployment; cloud persistence and current-Mac workers verified; dev alias cutover and signed-in verification in progress.

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

The deployment scripts are prepared; native runner smoke tests passed, while cloud integration checks remain pending. Schema, baseline and dev-only settings are verified below. Service enrollment and signed-in dev workflow checks remain open. Large COO transport now uses private-object delivery and passed a live synthetic 5 MB check. Native worker dependency versions and OCR quality must be verified on the actual selected runner. A code build or mocked database test does not complete these gates.

## Runner preparation verified October 27

An isolated runner was prepared on the existing Mac mini at `~/Library/Application Support/iClosed/LegalAssistant/HostedDevWorker`. It uses its existing Node 26.10.0, isolated managed Python 3.13.11, pinned PDF dependencies and a compiled copy of the repository OCR helper. Both native pages rendered and the scanned page's synthetic text was recognized. The Closer environment was unchanged. Worker source/dependencies are present; no secrets, client data, launch services or incoming listener were installed. Enroll only after the hosted baseline and configuration have been verified. Copy `worker-package.json` and `worker-package-lock.json` as the runner's package manifests; use `npm ci --ignore-scripts` to reproduce Node dependencies. The native preparation script uses `requirements.lock`.

The read-only source transfer plan found revision 52 with 67 matters, 78 frozen artifacts, two COO revisions and two saved mailbox connections. This is an inventory, not a hosted transfer or a database success claim. The private manifest is not committed and must be regenerated if source bytes change.

## Approved deployment and remaining cutover

The owner approved the reviewed dev-only deployment scope on October 27, 2026, after the conflict summary. The earlier automatic-review migration gate is satisfied. Production changes and client email sending remain outside scope.

Applied and verified in existing iclosed-dev only: additive table/CAS schema with RLS and service-role-only access; private artifact bucket under the project's existing 50 MB object limit; exact-hash transfer and readback of revision 52, 67 matters, 78 artifacts, two COO revisions and two encrypted mailbox connections. Owner-only receipts retain the exact manifest. No local source data was deleted or reset. Vercel settings were added only for Preview branch dev, with submissions/imports/sending still disabled pending worker checks.

Live cloud checks verified single-winner CAS, saved document readback, anonymous table/artifact denial, signed private upload and exact 5 MB result download. Large COO uploads, results and saved reviews now use private artifact transport so they do not cross Vercel as oversized JSON. Download links expire after two minutes; upload preparation and workflow validation remain staff-authenticated.

Mac mini enrollment could not run because this Mac is off its network (confirmed by the owner). The worker architecture does not require that specific machine. In response to the owner's request to proceed, four isolated persistent hosted-dev services now run on the available Mac under Application Support/HostedDevWorker. Both document/audit workers passed native PDF and scanned-page OCR preflight; the live cloud queue completed a synthetic three-notice COO with exact PDF hash readback. Gmail discovery succeeded, the migrated mailbox identity was confirmed, and daily sync skipped today's duplicate extract. Dev web submissions/imports are enabled after these checks. Client COO sends remain disabled.

These workers require this Mac to remain awake and online. Closer opening remains dependent on the separately prepared Mac mini script. Migrating workers to an always-on host is a later infrastructure improvement; it does not require changing the website workflow. Do not expose SSH publicly or weaken pinned host verification.

The local app remains intact and uses its existing local state. Hosted dev uses the verified cloud snapshot and independently saved later revisions; do not overwrite either with a stale baseline. Future synchronization must reconcile source and receipts explicitly. Signed-in hosted route verification remains required before calling promotion fully verified. A proposed rerun chosen from the latest completed report was blocked by automatic review because it did not prove membership in the ten specifically authorized historical files; it did not execute. The live cloud queue test used synthetic COO data instead.

## Final verification findings

- Full repository checks now pass 491 tests; the production build, TypeScript and scoped lint pass. Full lint's two imported fixture errors were corrected; remaining warnings are non-blocking.
- Signed-in local verification uncovered a real discovery stall: one added message had been deleted before retrieval. Discovery now recovers remaining thread content where possible, records unavailable-message coverage explicitly and prevents approval from surviving an unverifiable existing source. The isolated fix was backported and committed to the active local app; discovery resumed with zero model calls, preserved its queue and displayed its coverage gap on the signed-in screen. The source manifest must be regenerated after quiescing writers for transfer.
- Vercel blocked the draft branch's automatic previews because it could not find a Git account for the commit author. This is separate from the reviewed schema gate. Resolve deployment through an existing linked operator account after approval; do not add paid members, rewrite contributor identity or weaken project permissions. The dev alias has not changed.

## Cloud reliability correction

A real cloud audit exposed repeated idle CAS writes and a PostgREST statement timeout serializing the 4.3 MB audit-history row. Transactions now skip unchanged writes. A process-local cache checks the database revision on every read and never substitutes stale state during outages. Documents over 256 KB use a checksum-verified immutable private artifact; CAS only swaps the small artifact reference. Existing json-v1 documents remain readable. No baseline, history, approval or send receipt is reset. Both formats retain the exact serialized JSON order.

Deploy blob-v1 readers to every web/worker runtime before compacting the legacy audit document. Pause writers, preserve a private management read of that exact row, then run `compact-audit-document.mjs --snapshot <private-file> --expected-sha256 <checksum>` to verify metadata, adding `--apply` only for the reviewed exact row. The command refuses changed revisions, checksum mismatches and active leases, then verifies the saved logical state after CAS. Code rollback must retain blob-v1 support; old readers cannot interpret the new reference.

Worker cycles back off on dependency outages without replaying claimed jobs or restarting unrelated roles. Interrupted audits retain their failed/expired state and require a deliberate rerun. Client authentication subscribes once per mount and retries transient Auth errors twice; invalid sessions and exhausted retries still fail closed, and token events still reload server-verified grants.

## COO provider and scan throughput correction

The hosted COO route previously still selected Resend despite the separately connected Gmail sender. `ORCHESTRATOR_COO_EMAIL_PROVIDER=gmail` now selects the approved communication mailbox, checks the separate send connection and refuses a sender change after review. Explicit Resend configurations remain supported. The environment sending gate is independent: leave `ORCHESTRATOR_COO_SEND_ENABLED=false` in dev during acceptance; internal synthetic adapter tests do not enable website client notices. The UI disables approval while generation/attachment work is pending or sending is unavailable, and displays the actual environment/connection reason.

The one-CPU Linux OCR adapter pins `OMP_THREAD_LIMIT=1` inside the actual Tesseract subprocess, rather than relying on environment variables omitted by the PDF subprocess allowlist. This avoids oversubscribing the approved CPU allocation; see the [official Tesseract threading guidance](https://tesseract-ocr.github.io/tessdoc/FAQ.html#can-i-increase-speed-of-ocr). Native Linux/scanned-PDF CI remains required.

Fresh deed prepopulation was verified on a historical file with no saved COO. Its East Gwillimbury water recipient remains an explicit exception: the [Town's current water-account instructions](https://www.eastgwillimbury.ca/en/municipal-services/opening-or-closing-water-account.aspx) require registered owners to complete its account forms. A published payment-contact address does not establish acceptance of a firm's ownership notice. Do not invent a delivery recipient or mark an owner form complete from a generated letter.

## Janray evidence correction — October 28

New submissions freeze the verified register address and client identifiers with the job. Gmail discovery searches file-number variants and the street address, paginates up to 1,000 matches, and inspects at most 100 threads. Address-only threads need exact normalized street/unit identity plus client-name or email corroboration and reject competing matter numbers. Cutoff, bulk/derived-report and internal-test exclusions remain in force. HTML-only mail is readable without loading external content. New collection limits are explicit in coverage; zero live email appears above the report.

The 24-supporting-PDF cutoff is removed. Folder/inventory bounds remain explicit (100 folders, four nested levels, 256 PDFs); supporting documents and attachments are constrained by checked byte limits. Native review batches now account for PDF byte size as well as pages, including small-page large-scan matters. Consolidation reconciles dated extensions, deposits and settlement authority, retaining the original report and human dispositions. Suggested priority/owner/due point are advisory role suggestions; disposition and notes save through the existing revision-checked staff API. No automatic assignment, legal approval or sending is introduced.

Forwarded/quoted mail is retained with source headers and explicit quotation provenance; a 64,000-character body bound is reported when exceeded. Text-only correspondence is batched by page/context size rather than eight messages per request. For large matters, final synthesis uses bounded excerpts retaining provisional cited spans and full-source-pass observations; it explicitly reports this scope. Original frozen messages remain intact and publication still validates quotes against the full original manifest. A stopped capture is revision-fenced before provider review; it never overwrites the prior report or silently replays a paid call.
