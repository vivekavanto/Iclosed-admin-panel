# Repeatable iClosed tests

Run from the Admin repository with its existing dependencies and Node 22.13+.
On the local development Mac the existing Node binary is
`/Users/saru/Library/Application Support/iClosed/LegalAssistant/private/bin/node`.
Put its directory first on PATH when invoking npm. No dependency upgrade is needed.

```sh
npm test                         # safety + Legal Assistant + other Admin + pinned daily sync
npm run test:legal-assistant      # original module regressions, isolated
npm run test:admin                # other existing Admin tests, including PDF.js asset integrity
npm run test:sync                 # the five standalone sync regressions
npm run test:safety               # verify isolation barriers
npm run test:coverage             # validate scenario links; mapped does not mean passed
node scripts/testing/coverage.mjs --results all.json  # bind coverage to the latest matching full run
npm run test:integration:read-only # separate anonymous localhost GET checks; requires running app
```

`test-results/` is ignored. Each run writes a JSON result and run-specific checksum-bound TAP logs with classification,
counts, Node version, source commit, and a fingerprint that includes uncommitted source,
tests and harness changes. A source change invalidates coverage evidence. Skipped/todo
cases and absent suites fail the ordinary run; blocked live coverage stays explicitly
blocked in the matrix. These are scenario checks, not an instrumented line/branch
coverage percentage. CI validates the matrix, runs the full synthetic suite, and uploads
only its synthetic result directory using the existing npm pipeline.

## Safe default

The runner copies only source, tests, package metadata, the harness, the public brand logo and the PDF asset
script into an owner-only temporary directory. It rejects symlinks in these inputs.
It does not copy `.env*`, private state, logs, OAuth data or browser profiles. Inherited
credentials and Node injection flags are removed from the test child environment;
HOME, temp and state directories point into the disposable copy. Missing application
baseline remains missing; the runner never creates a business register. Tests create
only their own synthetic baselines. Scratch data is removed after the run, including
failed runs.

Node's permission model restricts reads to that copy and installed dependencies, and
writes to the copy. A preload rejects real fetch/socket/TLS/HTTP calls and subprocesses;
tests can inject mocked fetch/providers. Worker threads, native addons and arbitrary
filesystem access are not enabled. The existing PDF.js integrity test has one narrow
subprocess exception for the local asset-copy script; that child gets the same filesystem
and network restrictions and writes only disposable assets. Nothing runs migrations,
deploys, starts workers, sends mail, creates provider records or touches the approved
register. This is protection against accidental integration calls in trusted tests,
not a sandbox for executing hostile code. Do not run unrelated diagnostic/seed scripts
as tests or add real client material to fixtures.

The local app, audit worker, discovery-only monitor and daily scheduler are independent
of these commands. Leave their processes/configuration unchanged. Do not run `next build`
in the checkout serving the active development app merely to verify this harness; use
an isolated build checkout when a shipped-code change requires it.

## Organization and growth

- `tests/legal-assistant/*.test.ts`: existing module tests, preserved in place.
- `tests/*.test.ts`: existing shared/Admin behavior.
- `tests/suite/`: guard and harness regressions.
- `tests/fixtures/local-sync/`: byte-for-byte snapshot of the canonical daily sync's
  test and required sources. Its manifest records source revision and file SHA-256s.
- `tests/coverage-matrix.json`: actionable scenario inventory with stable IDs, exact
  test-title prefix selectors, limits and outstanding activation work.
- `scripts/testing/`: runner, isolation guard, source fingerprint, coverage validator,
  read-only HTTP smoke check and sync-fixture refresh.

For the next module, add `tests/<module>/`, synthetic fixtures beside its tests and
rows with that module name in the matrix. Extend the runner's suite allowlist and
file selection. Keep shared safety tests in the default command. Never discover tests
by executing arbitrary `scripts/` files. Each new scenario should have a unique test
selector and state what its assertions establish.

To refresh the pinned sync fixture after a canonical runtime change:

```sh
node scripts/testing/refresh-sync-fixture.mjs --source /path/to/canonical-admin-checkout
npm run test:sync
npm run test:coverage
```

The refresh command reads a fixed public-source allowlist, never `run.mjs`, configuration
or state. Review the manifest and diff. The scheduled runtime remains the canonical
standalone checkout. A pinned copy cannot prove it still matches a later runtime;
refresh it whenever that runtime changes. Do not redirect the scheduler to this fixture.

## Separate evidence layers

| Layer | What establishes a pass | Outstanding limits |
| --- | --- | --- |
| Automated synthetic | Assertions pass against injected providers and disposable state | No delivery, creation, live AI quality or Slack parity claim |
| Read-only integration | Current provider/API readback, date and scope recorded | Anonymous smoke only proves 401, not authenticated functionality; Tickler read access does not prove write access |
| Signed-in UI | Existing authorized browser renders expected routes, data and controls; reload verified | Alternate-user authorization needs its own session and evidence |
| Live provider | Explicitly authorized exact synthetic operation plus independent readback and idempotent retry receipts | Never part of npm test/CI; blocked adapters and consent remain blockers |
| Quality/evaluation | Approved frozen dataset and cutoff, versioned rubric, blinded review and measured outcomes | A mocked adapter is not semantic accuracy; no fresh ten-file benchmark exists |
| Automated Python | Pinned rendering runtime and synthetic PDFs, actual renderer assertions | Separate runtime; not counted in Node totals |

The known blockers remain in the matrix: shared annual number allocator, read-only
Tickler, incomplete Drive/Closer creation and partial recovery, COO activation,
email-to-OpenAI consent and a fresh ten-file quality benchmark. Proposed numbers are
not reservations. Discovery-only email monitoring must stay enabled without extraction.
Closer creation must use deterministic scripts and independently verified receipts.

## Signed-in local smoke checklist

Reuse an existing authorized browser at `http://127.0.0.1:3004`. Do not export cookies
or open the Mac mini persistent profile concurrently. Ordinary UI verification is
read-only; do not click Accept, Run audit, Refresh/import, Send, or any creation action.
Record time, route, visible expected labels and outcome without copying client details.

1. Open `/admin/legal-assistant`, verify the authenticated Admin shell, Legal Assistant
   register, source freshness label, date filters and Add New File navigation.
2. Reload; verify the register loads without login/error overlay.
3. Open Add New File, verify its input/review controls and setup blockers; save nothing.
4. Open Settings, verify mailbox/intake status and discovery-only mode; change nothing.
5. If an existing completed report is available, verify saved findings, feedback, one
   Run history and coverage section, and absence of package-selection control. Reading
   it must not enqueue a new audit. Record unavailable report coverage as not run. A manually observed UI receipt may be
   saved privately in `test-results/ui-smoke.json` with `classification: signed-in-ui`,
   source fingerprint, time, per-check observations, and status. Coverage consumes it
   only for the same source fingerprint; this receipt is never an automated browser pass.
6. Run the anonymous API smoke separately. Alternate staff access is a distinct check.

Approval/revocation UI mutations use a separately authorized disposable synthetic
request. Never inject one into the approved register as part of the normal suite.

## Python and quality follow-up

Existing Python tests remain in `scripts/test_audit_pdf_inspection.py`,
`scripts/test_audit_text_quality.py`, `scripts/coo/test_render_preview.py`, and
`scripts/coo/test_inspect_transfer.py`. With the preconfigured pinned Python/PDF
runtime, use `python -m unittest discover -s scripts -p 'test_audit_*.py'` and
`python -m unittest discover -s scripts/coo -p 'test_*.py'` from a disposable source
copy with synthetic fixtures, no credentials and networking disabled. Preserve the
current renderer runtime; do not install/upgrade it just to run the Node suite.
Record unavailable dependencies as blocked. Native rendering/OCR assertions must
actually pass before claiming PDF rendering coverage.

A future ten-file evaluation needs private case IDs, immutable source/cutoff hashes,
expected findings reviewed by a human, model/prompt/ruleset versions, exact citations,
unsupported-blocker rate, important omissions, resolution accuracy, clerk agreement,
latency and paid usage. Compare identical cutoff evidence with Slack without treating
Slack as website approval authority. Keep dataset/results private and separate from
synthetic fixtures; do not transmit real emails until the existing consent gate is resolved.
