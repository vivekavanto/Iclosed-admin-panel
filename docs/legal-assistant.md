# Legal Assistant

The Orchestrator is integrated as the **Legal Assistant** navigation item in Admin at `/admin/legal-assistant`. It includes the Closer register, file detail and Drive links, signing-audit review, overall feedback, COO review, shared municipality contacts and manual mortgage-instructions timestamps. It uses the existing Admin shell and login, not an iframe or a second deployed application.

## Routes and access

UI routes are under `/admin/legal-assistant` and APIs under `/api/admin/legal-assistant`, both protected by the existing Admin middleware. The central staff access policy now requires the `legal-assistant` module, with full owner access and preserved legacy admin grants. Verified company-domain staff start with no modules; Saru assigns access on `/admin/access`. See `docs/staff-access.md`. Existing messaging, reminder and other Admin features remain intact.

## Local and hosted configuration

Local acceptance testing reuses the existing private Closer/Drive/mailbox configuration and private local state through an ignored `.env.local`. No secrets, mailbox tokens, client register, historical reports or client PDFs are committed. Standalone Operations source remains intact as a backup, not a deployment dependency.

This merge does not make the workflow backend production-ready. Local job/settings/token storage refuses production mode. Hosted dev must have persistent database/blob/token adapters and a separately configured isolated worker before real audits can run. Review the additive register SQL in `docs/legal-assistant-schema` and apply it manually only after approval; no migration is run by this integration. This does not alter the existing deal, lead or client schema. Without backend configuration the dashboard displays a connection notice and real audit submissions remain disabled. Sending and Drive packet filing remain disabled.

Set `ORCHESTRATOR_APP_URL` to the Admin origin. New mailbox sign-ins need `<admin-origin>/api/admin/legal-assistant/mailbox/callback` registered on the existing OAuth web client. The callback is excluded from request logs. Existing refresh-token permissions are unchanged; this integration grants no new scopes. The machine-refresh API is still behind Admin middleware; configure an authenticated scheduler design before activation rather than making an unauthenticated exception.

COO is manually triggered only when the clerk is finished and the final registered deed is available. Rendering is deterministic and unsigned. An isolated Python runtime with the pinned `scripts/coo/requirements.txt` dependencies is required; template assets are explicitly traced. The existing OpenAI/Drive-write acceptance gates are retained.

Contacts use revision checks and retain edit history. Mortgage timestamps come from the server and preserve the first click independently of Closer re-imports. Overall audit comments are append-only and retained for review before shared audit rules change; no automatic suppression or model training is claimed.

## Validation

Use the existing Admin `npm test`, `npx tsc --noEmit`, `npm run lint`, and `npm run build` commands. Imported module tests live under `tests/legal-assistant`, use synthetic temporary data and do not send email, invoke paid AI or change client documents. An access regression test confirms the existing Admin role is required. Real client data stays behind staff authentication; the module's illustrative previews are also behind Admin middleware.

## PDF preview dependency maintenance

PDF.js is an exact-pinned `pdfjs-dist` dependency in `package.json` and the npm lockfile. `npm run dev` and `npm run build` regenerate ignored `public/vendor/pdfjs` assets from that one installed package through `scripts/sync-pdfjs-assets.mjs`. Vercel detects the existing `pnpm-lock.yaml`; dependency changes must update both npm and pnpm lockfiles. CI verifies the pnpm lockfile is frozen-install compatible. Custom build commands must run `npm run pdfjs:assets` first. The script keeps the library, worker, fonts, CMaps, WASM and upstream license notices together; no workstation runtime or CDN is involved. Generated assets must not be committed.

Dependabot checks npm weekly and groups PDF.js upgrades separately. For upgrades, review upstream release/security notes, update the exact version and lockfile together, run the asset integrity test and full build, then check multi-page text and scanned PDFs in the browser (including accents, embedded fonts and image-heavy pages). A successful asset-copy test alone does not prove rendering. Keep `isEvalSupported: false` and same-origin worker/assets. Dependency auditing remains advisory under the repository's existing CI policy; this change does not claim the whole dependency tree is vulnerability-free.

The managed renderer is pinned to **6.2.108**, the patched version for [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j), replacing copied 5.6.205. Use Node 22.13+ or a supported newer Node release for installs/builds; the final checks used Node 24.19. A synthetic two-page browser smoke check covered text, an accented character, standard fonts and a scanned image with the real worker. Historical client-document rendering still needs controlled acceptance before production rollout.

## Closing-date views and daily Closer imports

The default **Next week** view includes today and the following six calendar days, in Toronto time (a rolling seven-day window). **Next month** includes today through the same date next calendar month, clamped at month end. Upcoming views include active and closed files, so a file closed today remains reachable for COO work; inactive files are excluded from upcoming views. **Past files** includes retained active/closed/inactive records with closing dates from **2026-10-23** through yesterday, newest first. This date view does not assert that an active file has completed. Existing clerk/type/firm/search filters apply within each view. Midnight/date rollover is refreshed while a page is open. Earlier closing dates are not shown in Past files. Imports retain absent records and preserve verified Drive links; a changed Closer closing date moves the same file between views after import.

The source extract is available by 02:00 America/Toronto. Vercel Cron calls `/api/internal/legal-assistant/refresh` at 06:15 and 07:15 UTC. The handler refuses runs before 02:00 Toronto time, and the second run skips when today's full-coverage extract was already incorporated. This produces a 02:15 import in both seasons, with a 03:15 fallback on spring-forward day. It requires Vercel's existing `CRON_SECRET` bearer header and explicit `ORCHESTRATOR_IMPORT_ENABLED=true`; disabled runs cannot read or write data. Staff middleware remains unchanged. The previous Admin refresh endpoint remains behind staff authentication and its separate secret.

Automatic imports require today's detailed CSV to cover today through the rolling month end. Missing, ambiguous, stale, summary-only or incomplete sources retain the prior register. Revision guards and the existing checksum/transaction prevent duplicate or concurrent replacement. The visible Closer source date and stale warning reflect the last successful import, not an attempted cron run. Vercel logs/cron status must be monitored for non-200 refreshes; no automatic staff notifications are configured.

### Activation checklist

Production was checked read-only on 2026-10-23: `public.orchestrator_files` and `public.orchestrator_snapshot()` were absent, and the live page had no imported extract. Daily production ingestion is not active. Before enabling it:

1. Review and explicitly approve the three additive SQL drafts in `docs/legal-assistant-schema`, then apply the base schema, folder links and the 2026-10-23 coverage-function update in the production `iclosed` Supabase project. Verify anon/authenticated cannot call the register functions or read the workflow tables; only service_role may do so. Existing lead/deal/customer tables are not modified.
2. Privately configure the existing Google read-only service account for the Closer extract folder in the production Vercel environment; verify the account can read the designated source. Retain its existing Drive permissions and do not configure writer/mailbox credentials for this import.
3. Verify production Supabase URL/service-role configuration and `CRON_SECRET`, deploy this branch after review, then explicitly enable `ORCHESTRATOR_IMPORT_ENABLED`. Do not copy private local state or credentials into the repository or expose them in output.
4. Review a current detailed source, approve/apply the initial import, and verify source date, file counts, date boundaries and sample identity/date changes. Run an authenticated scheduler acceptance check and repeat to confirm no duplicate import. Confirm failed/incomplete extracts leave the prior register unchanged. This writes the new Legal Assistant register, not Closer, Drive documents, emails or existing client/deal records.

The daily job imports extracts already produced in Drive. It does not generate Closer reports or automate Closer's website. Production activation, schema changes and the initial real-data import remain approval gates; code tests and previews do not establish live ingestion.

## Dashboard controls and document sources

All Files includes every clerk within the chosen date view; search and Clerk/Type/Firm filters still apply. My Files adds the existing explicit email-to-clerk mapping; unmapped accounts show no assigned files. Closed files remain eligible in upcoming date views, and Past files retains active, closed and inactive records from the established archive start.

Refresh from Drive reads the latest available detailed Closer CSV and presents a change preview. Apply import saves that reviewed source, guarded by checksum and register revision. Import extract is the equivalent preview/apply flow for a local CSV. Link Drive folders verifies file number, property/unit tokens and ancestry beneath the approved matter roots, in bounded groups; it saves only register links and never changes Drive documents. Folder names may omit a terminal road type, but conflicting road types and wrong units remain rejected. Ambiguous matches stay unlinked.

File numbers open file details. Linked property addresses open the verified Drive folder; unlinked addresses display a clear status instead of opening the details dialog. Table addresses omit province/postal code for display only, retaining the complete imported address for notices and folder verification.

COO pages read existing PDF metadata from the linked matter folder and its explicit Change of Ownership, Final Report and Documents subfolders. Existing notices and deed candidates are linked for review; drafts and in-preparation transfers are excluded. This does not establish registration, delivery or a completed workflow from a filename. A new notice still requires confirmed final-deed inputs; closed status alone does not supply them. The preview-generation request uses `/api/admin/legal-assistant/coo/preview`.

Local signing audits require the private `ORCHESTRATOR_AUDIT_OPENAI_KEY`, `ORCHESTRATOR_AUDIT_MODEL`, an absolute PDF-runtime path, local job storage and explicit shadow-mode activation. A separate `node --experimental-strip-types scripts/run-audit-worker.mjs` process handles queued jobs. Selecting a PDF does not submit it: the user confirms the exact package in the audit workspace. Model metadata access is not an end-to-end paid audit test. Hosted deployment and Drive report writing remain separate configuration gates.

The signing-package selector defaults to a unique PDF named Signing package (including hyphen/underscore variants), then to a unique PDF named for the property address. Address comparison preserves building/unit numbers and normalizes common road types. Multiple matches leave the selection empty for a manual choice. A user selection is retained during refreshes, and defaults never submit an audit.

COO preparation is exposed through Prepare COO. The editor guides transfer details, selected notice recipients, and attachment confirmation; Generate review packets renders the local review PDFs. A deed can be attached read-only from the verified matter folder, with inventory membership, size, parent and modification checks before/after download. Required registration details and full-transfer confirmation are still explicit; no notice is sent.

Audit failures retain a safe stage and known provider error code, HTTP status and request ID, without provider bodies or client text. The audit page shows the latest connection check separately from prior run history. Quota exhaustion requires funding the API account before a manual rerun; failed jobs are never automatically retried. Scan/mailbox coverage limitations remain separate from execution failure.

### Historical comparison improvements (local acceptance)

Source selection normalizes filename separators, prioritizes operative agreements/amendments, lender and title evidence, deduplicates identical PDFs, and excludes earlier audit outputs. The bounded inventory includes title-search and accounting folders. Up to 24 eligible supporting PDFs are captured; folder, depth, source, size, version and visual limits remain explicit coverage limitations. An unreadable supporting PDF is excluded with a coverage warning; an unreadable primary package still fails the run. Frozen primary version time is distinct from retrieval time.

Supporting PDFs are included in visual review alongside their extracted text. Larger matters use bounded package-plus-support passes and a final consolidation across all captured page text. Worker leases renew between passes; failed runs retain the existing report. This is staged evidence processing within a job, not an automatic retry of a failed paid job. Review completeness must be assessed from the source inventory and coverage panel, not from a completed status alone.

Optional local macOS OCR can be configured with an absolute `ORCHESTRATOR_AUDIT_OCR` executable compiled from `scripts/audit-ocr-macos.swift`. It reads pages locally with Apple Vision, including pages with broken `(cid:...)` font mappings. It uses a CPU-compatible recognition revision and per-page fallback; pages still unreadable remain coverage gaps. Other hosts need their own tested OCR runtime. OCR provenance is retained and quoted OCR evidence cannot independently propose a signing blocker. No OCR binary or client source belongs in Git.

The audit workspace lists package-page, supporting-document and mailbox counts, source names and page links, OCR/readability information and coverage limits above the report. Financial arithmetic guards cannot upgrade an unverified quotation into a verified finding.

COO preparation leaves incomplete optional condo and water contacts unselected, so they do not block a known tax notice; staff can select and complete them explicitly. Attaching a searchable registered deed can populate empty instrument/date fields from its registered heading, without overwriting entered values. Required full-transfer confirmation and renderer comparison remain in place. Review notices display the registered instrument and registration date. Sending, signing, filing and hosted persistence retain their separate deployment gates.

## Registered deed prepopulation

Opening a real COO file now reads searchable deed/transfer candidates from its verified Drive property folder and the existing supported document containers. A single matching registered deed (identical-byte duplicates count once) attaches automatically. Both explicit Drive selection and local upload use the same extraction and identity checks. More than one distinct matching deed, an absent role-specific client file number, mismatched civic/unit or street, incomplete declared page count, encrypted/scanned/unreadable PDF, or conflicting registration headings is a source exception; no candidate is silently chosen by modification date.

The deterministic parser reads the labelled Transferor/Transferee sections, addresses for service and the solicitor explicitly acting for the transferees, excluding land-transfer-tax affidavits. It prepopulates client and new-owner names, correspondence addresses, instrument/date and purchaser counsel on sales. The property address retains the verified matter's formatting and is checked against the deed. Short legal descriptions may appear on the cover; the complete deed always accompanies it. Condo plan text can supply a corporation-name suggestion, never a guessed management email. Clerk and municipality recipients remain sourced from the trusted register and directory, not inferred from a deed or email domain. Added tax defaults cover Mississauga, Markham and Oakville with official source links; explicit directory edits override defaults.

The source summary displays the instrument, page count and extracted facts before **Review deed and generate COO** confirms the attachment and produces an unsigned review packet. Advanced editing remains available. Different owner service addresses, recorded shares that do not total 100%, missing addresses and a Closer/registration-date difference are shown as exceptions; conflicting dates still require explicit confirmation. Extraction does not overwrite an editing session with a late automatic response. No source documents, notices, database schema, sends or Drive filings are written by prepopulation.

Private acceptance reran the ten historical registered deeds against the original Slack packet facts, rather than supplying those facts to the extractor. Instrument, date, role-specific file number and owners matched all ten; purchase service addresses and sale purchaser-counsel contacts matched their historical packets after normalizing only case, spacing, punctuation and Ontario/ON. All ten generated complete unsigned packets using extracted deed facts and the historical recipient selections. This validates extraction/rendering, not unattended recipient/service decisions, signed delivery, or live filing. The live 26P-0588 page also loaded its actual Drive deed and generated a five-page tax review packet without typing any fields. Condo water notices start unselected until a direct water account is verified; an address or known city utility alone is insufficient evidence of a separate account. Scanned deeds and absent management contacts remain explicit exceptions. The original ChatGPT COO skill package was not accessible in the connected/local sources; actual Slack threads and completed packets were used as the observed baseline.

## Persistent local app recovery

The previous local acceptance branch can be recovered independently of an incomplete temporary checkout. The recovered application retains the existing authenticated Admin routes, the deed prepopulation and audit changes, and the same approved register; no baseline is reinitialized. Keep `.env.local` as an ignored link to an owner-only environment file outside the repository.

`scripts/run-local-legal-assistant.mjs` starts the loopback-only development server on port 3004 and regenerates the pinned PDF.js assets first. Its `--worker` option starts the existing configured audit worker. The script fails if private configuration is absent. User login services may supervise these two commands with RunAtLoad/KeepAlive, private logs and an explicit persistent working directory. Store the actual app, state and runtime in Application Support so a login service does not depend on a temporary folder or protected Documents access. Keep machine-specific LaunchAgent configuration and all private files outside Git. Local execution still depends on this Mac and the user login session; it is not a hosted deployment.

## October 27 local audit improvements

The dashboard excludes matters whose explicit Closer mortgagee names identify Antrim, across every date view and clerk tab. Lender metadata is retained by both the app importer and independent daily-sync importer; other files assigned to the same clerk remain visible. Previously approved extracts can enrich this metadata under revision locking without replacing business fields or local workflow state.

Audit labels use Begin audit. The workspace and register show a spinner and Audit in progress while a job is queued, capturing or reviewing; the register polls the authenticated status endpoint. Report categories have distinct headings, borders and backgrounds; change/movement labels no longer occupy a second summary column. Internal legacy configuration flags remain compatible.

Package selection prefers a unique Signing package PDF, then an exact address-only PDF. A unique address-only match may tolerate one letter substitution in a long alphabetic token; numeric building/unit identity, road type and remaining tokens must match. Ambiguity still requires selection.

PDF inspection renders each page using the installed PDFium dependency, independently of the login-service PATH. A per-page extraction exception is retained for local OCR and visual review instead of excluding the whole PDF. Rendering failures remain explicit; missing extracted text is never proof of a blank page. Native PDFs are supplied for model visual review. Mailbox authorization is separate from Drive access; an absent mailbox connection remains a coverage limitation, so execution success alone does not establish parity with the Slack workflow.

After any task, verify the running authenticated Legal Assistant pages and affected user flow before reporting completion. Health checks and type/unit tests alone are insufficient. Use existing saved login/autofill when available without reading or displaying the password. Keep the worker running through active audits; after a worker restart, confirm the replacement is ready before submitting a test. A completed website report takes precedence over a historical Google Doc in the dashboard; the Google Doc remains separately accessible in the audit workspace. Capture diagnostics log only phases, source kinds and page counts, never document contents or credentials.

Local OCR time allowances scale with the scanned-page count, within a bounded twelve-minute inspection deadline that remains shorter than the worker lease. A slow batch retains a coverage limitation if it still times out; the native PDF remains available for visual review, including at consolidation when searchable text is limited.

Successful page inspections can be reused privately by exact PDF checksum and inspector/OCR-runtime version. Every capture still verifies Drive versions and downloads the current immutable bytes. Failed rendering, failed OCR and invalid/incomplete page metadata are never cached. Cache files contain private extracted evidence, remain owner-only beside audit state, and never belong in Git. Source-coverage observations remain in the report history and current coverage panel, apart from the main document findings.

Final coverage is the consolidated assessment of the full capture. Notes written for individual source subsets remain available separately in run history; they must never be concatenated into the overall limitations, where “not supplied in this pass” falsely suggests an available document was never reviewed. Programmatic visual-budget limits remain global limitations. Older runs retain their original pass notes in history without presenting them as overall capture failures. The evidence panel reports the actual rendered-page count separately from searchable-text coverage.


## COO contact defaults and local sessions (October 27, 2026)

- The prior-closing-date view is labelled **Closed files**. Its original date window and source statuses are retained; a past closing date does not rewrite a matter to closed.
- Detailed imports retain every indexed client email and the own-side brokerage/referral-agent emails. Opposing brokerage contacts and mortgage brokers are not silently copied. COO CC deduplicates those known contacts with the assigned clerk. The independent daily-sync parser mirrors these fields. Accepted historical extracts can backfill contact metadata under the existing revision lock without replacing verified register fields or import receipts.
- Toronto/Ottawa defaults select a combined **Municipal tax and water** notice. Separate providers use separate notices; verified water contacts are no longer suppressed merely because a property is a condo. Condo common-expense inclusion remains a reason to deselect a separate water notice. Untouched legacy directory entries gain newly verified provider defaults; manually saved routes remain authoritative.
- Condo corporation identity comes from the registered deed. Management contact extraction reads current status-certificate bytes in the verified matter folder and can reuse exact-hash inspection metadata from audit capture. Extraction requires the matching corporation and source-page quotations for every populated value. Optional missing emails remain visible exceptions; company/address facts are still prefilled, and an incomplete condo notice remains unselected. No outgoing messages or client documents are written. Model response storage is disabled. Successful contact facts are cached privately by source hash and corporation, and are revalidated against source text on reuse.
- Mississauga shows the requested client-submission handoff with the owner-signed tax form and Peel water-account instructions. The public owner-signature requirement is distinguished from an unverified blanket prohibition on lawyer forwarding. Contacts and source links remain reviewable.
- Local Admin development uses its own Supabase session-cookie name across browser, middleware, callbacks and server readers. This prevents other localhost apps from overwriting its cookie. Deployed cookie behavior and access gates are unchanged. The auth listener subscribes once and retries transient network failures; invalid sessions and revoked permissions still fail closed.
- Apple Vision OCR reads native PDFium-rendered PNGs rather than PDFKit thumbnails. This avoids embedded-font glyph loss. Recompile the existing local OCR helper after source changes; inspection-cache fingerprints include the helper runtime and native renderer version.

Official contact evidence checked October 27, 2026:
- Toronto: https://www.toronto.ca/services-payments/property-taxes-utilities/property-tax/buying-selling-or-moving/
- Mississauga tax account: https://www.mississauga.ca/services-and-programs/property-taxes/manage-your-property-tax-account/view-or-update-property-tax-account-information/
- Owner-signed tax form: https://www.mississauga.ca/wp-content/uploads/2023/11/2185-Tax-account-information-change.pdf
- Peel water accounts: https://peelregion.ca/services/water-billing-accounts
- Markham water provider: https://www.markham.ca/neighbourhood-services/water-sewer/rates-meters-billing-fees
- Alectra billing: https://alectrautilities.com/water-and-wastewaterstormwater-billing-rates
- Halton water billing: https://www.halton.ca/for-residents/water-and-wastewater-services/water-meters-rates-and-billing/water-bills-rates-and-fees


## Mailbox connection recovery

The Admin runtime needs the existing mailbox-specific OAuth web-client ID and secret in its private environment (`ORCHESTRATOR_GMAIL_CLIENT_ID`, `ORCHESTRATOR_GMAIL_CLIENT_SECRET`). These are separate from staff Google sign-in credentials and the read-only Drive service account. Keep the private credential JSON outside source control; do not print it or put it into browser forms/chat.

For the permanent local Admin preview, use `ORCHESTRATOR_APP_URL=http://localhost:3004` and register exactly `http://localhost:3004/api/admin/legal-assistant/mailbox/callback` on that OAuth client. A retained standalone callback on port 3002 does not authorize the Admin callback. `redirect_uri_mismatch` is a Google registration issue; changing the mailbox account cannot resolve it. Preserve existing redirect registrations when adding the Admin one. For hosted environments, register their separately reviewed HTTPS origin instead.

The connection screen explicitly distinguishes an unconfigured app, missing mailbox authorization, and saved authorization. The setup action remains usable when configuration is incomplete rather than presenting an inert disabled Connect button. With configuration present, a native HTML form starts Google’s authorization flow without a client-state rerender interrupting submission. The development default origin is Admin port 3004.

Authorize only `communication@navawilson.law` with the exact read-only Gmail scope. The callback validates operator-bound expiring state and PKCE, verifies the actual mailbox profile, and persists an encrypted refresh token only after identity and scope checks pass. A Google Cloud administrator’s account used for editing the OAuth client does not become the audit mailbox. Google verification/consent remains a separate required step; a working button or saved client credentials alone must never be reported as a connected mailbox.

After configuring private environment values, reload the local app and the idle audit worker. Verify the signed-in site, Google redirect, stored mailbox identity and an actual read-only capture before claiming email coverage. Old audit reports retain their original source coverage; rerun a selected audit to include newly available mail.

## Register settings and client communication tracking

The register links to `/admin/legal-assistant/settings` for Audit mailbox, municipality contacts, Refresh from Drive, Link Drive folders and Import extract. The settings screen reuses the register import preview/apply and folder verification controller, preserving existing manager checks, checksums and revision locks. Its help explains each action; moving the controls does not connect a mailbox or apply an import.

Current retains the rolling seven-calendar-day window, including today, in Toronto time. A quiet Next week divider marks the next Monday within that window. Filters and explanatory text sit below the file count. Reports and refinance scope Review links use grey, while Begin audit, Prepare COO and Inform Clients use green. Refinance Review still checks whether an actual ownership transfer warrants COO preparation.

Inform Clients opens a manual confirmation with the available client email addresses. It does not send messages. Only an explicit staff confirmation records Clients Informed, with actor and timestamp, in the independent local workflow settings. Existing lender-instructions receipts are retained separately and never migrated into client-notification confirmations. The new confirmations remain independent of daily Closer imports. Hosted persistence and live notification sending retain their deployment gates.

## Report-first audit display

The authenticated audit page includes the saved audit snapshot in its initial server render. Loading saved findings reads local audit/workflow state only; it does not enumerate Drive PDFs. The API and page share the same snapshot projection, excluding full source manifests. A saved report shows findings and Overall feedback first, followed by package selection, evidence, documents, coverage and history. Drive package choices load on demand when preparing a rerun. Begin audit keeps its package-first layout and default PDF selection, without the explanatory default-selection paragraph.

## Feedback review and completed-report layout

The register and audit workspace link to `/admin/legal-assistant/feedback`. It lists all existing Overall feedback entries, author, timestamp, file and report revision, and supports new general or file-specific feedback. Legacy entries without a status display as Pending review; originals remain unchanged until an explicit review. Existing managers may approve, decline, reopen or record implementation. Decisions are appended with reviewer, timestamp and note, guarded by expected current status. Implementation requires prior approval. Feedback remains independent of Closer imports in local workflow settings.

Only approved/implemented file-specific comments are used as model context; pending/declined and general entries are not injected into audits. Approval alone does not implement shared rule changes. Completed reports omit the package selector and introductory approval banner; a package selector appears only in the explicit rerun confirmation. Each run’s Evidence reviewed and source inventory appear inside Run history and coverage, avoiding a second copy of the latest coverage section.

## COO review revisions and delivery staging

Mississauga register actions show Client Only and Clients must submit for Mississauga, including for saved revisions. Other newly generated notices show Review; all notices in the current revision must have provider acceptance receipts before the register shows Sent. Sent means provider acceptance, not recipient processing or Drive filing. The COO page collapses file, deed and Drive background, puts Review deed and generate COO first, and displays the registered deed or generated PDF below it.

Generation freezes the exact PDFs, To/CC, sender, subject and body in owner-only local COO workflow storage. The approval references that revision and content hash; stale revisions and missing approval cannot send. Identical regeneration reuses the existing revision, including any send receipts. Approval is recorded before the external call. Partial or ambiguous sends retain receipts and block duplicate retry pending reconciliation. Generated delivery-ready notices remove review-only markings before human approval; no signature asset is introduced or applied. Mississauga firm sends are also blocked by the send API using the current register locality.

The staged COO provider adapter requires explicit private ORCHESTRATOR_COO_SEND_ENABLED, ORCHESTRATOR_COO_RESEND_API_KEY and ORCHESTRATOR_COO_FROM configuration for a verified firm sender. These are not enabled by the separate Gmail mortgage-test connection. The October 27 synthetic test to communication@navawilson.law was rejected by the existing test-only Resend account (403); no receipt or Sent status was claimed. Client sends, Drive filing and hosted deployment have not been exercised.

## Mortgage-instructions email internal testing

Inform Clients now opens a rendered email preview using the unique active saved template matching the mortgage-instructions wording; if none is available it uses the supplied template verbatim. Greeting and address placeholders use the existing single-pass HTML-escaping renderer. The existing subject is retained, with an INTERNAL TEST prefix and file number. Multiple matching templates or unresolved placeholders block sending.

Only internal testing is enabled in this flow. Its recipient is fixed server-side to communication@navawilson.law, with no client To/CC recipients. The preview clearly identifies intended clients separately from the actual test recipient. A reviewed content hash and per-click request ID bind the send; durable intent precedes the Gmail call, receipts deduplicate retries, and unknown outcomes block repeats. Test sends never update the mortgage Clients Informed record. Internal-test subjects are excluded from audit evidence so test messages cannot establish client notification.

A separate Gmail sender connection at /admin/legal-assistant/connections/sender requests only gmail.send plus OpenID email identity. Its operator-bound, expiring PKCE authorization and encrypted token files are separate from the read-only audit mailbox connection. Both use the registered Admin callback; a separate state cookie and token directory route sender callbacks without replacing audit tokens. Account identity must be verified as communication@navawilson.law, and broader returned scopes are rejected. Only the email-test send action invokes the Gmail sending transport. Google sending consent remains a required human step, and no connection alone sends an email.

## Repeatable regression suite

`npm test` now runs all existing Node regressions plus the pinned standalone daily-sync tests in disposable source/state with credentials stripped and live networking blocked. See [Testing](testing/README.md) for focused commands, provenance, the scenario matrix, read-only/UI checks and explicit live/quality blockers. No ordinary suite command sends email, calls paid models or touches the approved register.


## Client notification previews

The register starts with closing date and file number. Mortgage instructions and Funds received actions are available only for purchases and refinances; the API also rejects sale files. Funds received refers to mortgage funds from the lender. Both previews show intended clients and deduplicated referral-source CC addresses from the register.

Mortgage previews include the portal-style insurance checklist and selectable lender chips. A single exact recognized lender defaults; ambiguous/unknown lenders require a clerk selection. The common mortgagee addresses come from the supplied portal checklist and must be checked against file-specific instructions. Other lender omits an assumed address. Changing a lender regenerates the preview and its approval hash. No environment variables or database migrations are required.

These actions retain the existing internal-test delivery mode: only communication@navawilson.law receives test messages, with no client or referral CC, and no Clients informed status change. Mortgage and funds tests have independent deduplication keys and uncertain outcomes cannot be automatically retried. This feature does not enable external client delivery.
