# Legal Assistant new-file opening

## Implemented local increment — October 27, 2026

The register has an Add New File link beside the date views. Authenticated staff enter property address (including unit/city), multiple client names, multiple referral sources, closing date, explicit firm and transaction type. Marcela Pitella is the default clerk; Suganya Argeen and Abishan Thuraiaiya are alternatives. Aliya remains CSM.

The server reads the complete configured Tickler tab with read-only Google credentials and validates the live column layout. The current Tickler has headers on row 1, unlike the older handoff. The annual shared P/S/R maximum determines a proposed number; gaps are not filled, malformed numbers and outlier maxima block numbering, and a new year requires a reviewed current-year baseline. A proposed number is never a reservation.

Review shows conservative duplicate candidates, including different units in the same building, and the proposed firm/clerk/type/year/month folder path and six standard subfolders. The closing year controls folder placement; the opening year controls the number.

Saving re-reads Tickler and binds the plan to the exact input and full sheet fingerprint. A changed sheet or changed details requires a new review. Private opening requests use owner-only atomic local storage alongside the existing canonical state, with independent locking and stable request IDs. Missing baseline is an error; no new business register is initialized. Requests do not become imported/opened matters and never modify state.json.

## Verified activation blockers

- Existing service-account metadata reports canEdit=false for Tickler 2026. Read-only readiness is not write readiness.
- No shared reservation service coordinates the website, manual Tickler entries and the old Mac workflow. A local lock alone cannot prevent duplicate numbers.
- Firm-specific Drive writer destinations require independent verification. Existing read access does not authorize or establish folder creation.
- The historical Closer reference was recovered through the Drive IDs retained in local file attributes. It fills the first form but explicitly stops before creation. It is not a complete unattended runner. The user has signed into Closer as saru+1@navawilson.law; no browser session has been exported. SSH access and the existing Mac mini Playwright profile are now verified. The complete creation runner remains unfinished. Closer creation, referral notes, assignment, fields and post-create reload/readback need separate script testing.

There is deliberately no live opening POST action yet. The UI exposes these connection requirements and offers Save opening request, not a misleading Opened/Sent/Complete state. No Tickler rows, Drive folders, Closer matters, emails or hosted schemas were changed by this increment.

## Next execution increment

After provider access and the shared allocator are established, require exact reviewed input revision before execution. Persist each operation intent before calling a provider; reconcile uncertain results before retry. Reserve/verify numbering and Tickler first, create/reconcile verified firm/clerk folders next, then create/reconcile Closer and independently read back identity and assignment. Keep separate statuses/receipts. Do not allocate a second number or recreate folders after partial failure. Project into the register only after verified authoritative identity.

Historical baseline: NW-file-opening-pipeline-spec.md (Google Doc 178jMmiZ_9sW6t8ZbJ_Z_AAS01B5LBNxY8KYN8-j1uoM), September 22 pilot in #fileopening, and September 24 instruction keeping Closer manual pending reliability. The user now requests automated Closer creation with separate testing. Website operator/revision approval replaces Slack reactions; never manufacture Slack approval evidence.

## Required execution mode

The user explicitly requires deterministic script execution for Closer, preferably reusing the existing Mac mini runner. Do not create files through model-driven browser interactions or spend model/browser-use tokens per opening. Browser sign-in does not establish a reusable script session; never silently export its cookies. Recover the current Mac mini script and operational journal before integration. A dedicated SSH key, pinned known-host identity and scoped connection configuration are saved privately on this development Mac. No connection secrets or browser state are committed.

The known historical root is `/Users/claudaratnam/Claude OS/Scheduled/daily-closing-report/file-opening-recovery`, with `work/nwfileopen/` source and `work/flow.db` state. Preserve existing state and independently verify current code and runtime; do not execute the redacted reference bundle as a backend. Website approvals must bind exact revised input and source/destination identities.

## Mac mini access and readiness verification — October 27

SSH login as the existing workflow owner was verified after repairing malformed pasted authorized-key text. The original file was backed up; the installed public key retains the restrict option. The temporary public-key transfer server was stopped. The standard Remote Login service is used; the debug listener is not an application dependency.

The existing Closer Report Downloader has an installed Python Playwright environment and a dedicated persistent profile. A read-only probe verified the rendered profile email as saru+1@navawilson.law. No cookies or credentials were exported and no report/download job was invoked. Existing historical flow.db, pending cases and automatic-review blocks remain untouched.

`scripts/legal-assistant-file-opening/closer_probe.py` is also installed in the Mac mini owner-only Application Support/iClosed/LegalAssistant/FileOpening directory. It refuses missing/busy profiles, verifies the actual Settings email, closes its browser context, and emits bounded status JSON without client data. Live execution returned authenticated/account_verified=true/model_calls=0/creation_enabled=false. This proves script runtime readiness, not a completed opening workflow. Full creation still needs an input-revision-bound job, shared allocator, verified Tickler/Drive writes and independent Closer create/readback receipts.


## Email opening inbox — October 27, 2026

The persistent local service runs `node --experimental-strip-types scripts/run-email-intake.mjs`. Gmail discovery runs every 120 seconds independently of the extraction worker, so slow model calls do not postpone polling. `--discover-only` disables extraction entirely; `--once --discover-only` performs one discovery check. This is a deterministic application service, not an agent conversation. It currently runs on the same Mac as local Admin; Mac mini remains the target for scripted Closer creation. All runtime paths use permanent Application Support storage.

Initial discovery paginates the preceding 30 days and recognizes internal sender addresses and new-message opening instructions. Later checks use Gmail message-added history. A missing/expired checkpoint or changed detector version triggers bounded rediscovery. The checkpoint advances only after complete discovery is durably queued. Missing configuration, baseline or incomplete coverage retains prior records. No business register is created or modified. Gmail authorization remains read-only.

Shared cards appear above the register and on Add New File, visible to the recognized requester, addressed clerk and participating internal lawyer/staff. Existing managers retain oversight. Unrelated module staff cannot read or approve requests through the API; model output cannot grant access. Corrections add the selected clerk's trusted aliases. Broader staff mappings require a trusted roster update.

The detector excludes acknowledgements, quoted repeats, signature boilerplate and confidentiality footers. Extraction uses the configured opening model/key with the existing audit model/key as fallback, strict JSON schema, no model tools, and store:false. Text is bounded to 80,000 characters; oversized threads become explicit exceptions. Nonempty fields require matching source quotations and contact emails must occur in source text. Attachments are not sent to the model in this increment. Original non-inline-image Gmail attachments are captured privately by verified SHA-256 for later filing.

Unchanged substantive message hashes cost no model tokens. A durable paid intent precedes extraction. Failed/interrupted calls pause automatic retries; successful results are cached for downstream retries. A maximum of 25 actual attempts per UTC day includes backfill usage. Settings shows measured input/output tokens and calls. Ordinary polls, attachment copying, matching, approval and idle checks invoke no model. Candidate counts are not verified new-file counts.

One participant can accept a complete request in one click. Atomic revision checks deduplicate simultaneous approvals, record actor/time/content hash, and invalidate approval on new source content. Corrections resolve exceptions while preserving evidence/history. Identical cross-thread requests are flagged. Tickler matching respects transaction type/year; matches do not reserve numbers or prove opening completion.

Execution remains blocked by read-only Tickler access, an inactive shared allocator and incomplete Drive/Closer creation adapters. Accepted cards therefore show Approved / Waiting for setup, never Opened. No Tickler append, new client folder, Closer matter, send, hosted migration or deployment is performed by this monitor.

Automatic approval review requires explicit ongoing authorization to send these email conversations to the configured OpenAI destination. Until resolved, the installed service must retain --discover-only. Enabling extraction requires that authorization, removing the flag from the private service configuration, restarting only this service, and verifying live extraction/bytes/usage and signed-in pages. Never route extraction through another tool to bypass this gate.


## Workflow regression verification — October 27, 2026

Extended synthetic tests exercise email changes after approval, failed re-extraction, changed extraction keys, explicit reassignment, linked purchase/sale matters, same-name PDF amendments, duplicate attachment bytes, truncated capture, expired Gmail history, paid-call caps and cached retries. Discovery now revokes approval as soon as new substantive source content is observed, even with extraction paused or failed. A pending source hash keeps approval blocked through manual edits until updated source processing completes. Original approval history remains intact. The latest explicit clerk instruction is checked independently of model output. Replies beginning with thanks still count when they contain additional facts or documents; short substantive date replies are retained. Source fingerprints include attachment identity.

COO delivery tests change recipient/sender/PDF revisions, tamper persisted recipients, simulate ambiguous acceptance and change the latest revision during delivery. Remaining messages stop when the current reviewed revision or saved hash changes; accepted receipts remain recorded and uncertain revisions cannot automatically resend. No actual COO notice was sent in these tests. Existing Tickler/Drive/Closer creation and COO provider activation blockers remain separate.

The signed-in register was tested with a disposable synthetic card: one-click acceptance persisted across reload, then changed source information removed the approval and disabled opening. Settings and an existing completed report were also checked; completed reports hid package selection and retained feedback plus one Run history and coverage section. The shared mailbox and canonical local register were verified read-only; the Mac mini deterministic Closer probe remained authenticated with creation disabled. One explicitly authorized synthetic mortgage email was sent only to communication@navawilson.law, read back, and repeated with the same request ID without another transport call. Clients Informed stayed unchanged. The internal test receipt is retained privately; disposable UI requests are removed after verification.
