# Team updates and client receipt milestones

Client mortgage-instructions and lender-funds previews include Aliya and the recorded referral sources in CC, deduplicated against To. Internal tests override all recipients and never update portal milestones.

## Portal reconciliation

Only confirmed `mode=client`, `status=sent` email receipts with provider IDs qualify. The cloud reconciler runs every 15 seconds, and retries failed portal updates after five minutes without invoking any email sender. It matches exact annual file numbers and transaction type, verifies that matching deals belong to one lead family, resolves one active receipt stage template, refuses missing/duplicate milestones and milestones containing tasks, and reads all saved statuses back. It completes only the receipt milestone, preserves an existing completion date, and marks its email sent. It never changes insurance/signing tasks or triggers a second milestone email.

Purchase stages: Mortgage Instructions; Lender Funds Received. Refinance stages: Financing -> Mortgage Instructions & Review of Mortgage Terms; Funds Release by the Lender. Names are normalized for whitespace/case only; ambiguous mappings require intervention.

`ORCHESTRATOR_PORTAL_SYNC_ENABLED=true` must be explicitly configured in the appropriate hosted profile. Local JSON runs do not write the portal. Reconciliation receipts are private document `portal-sync`.

## Slack

Dedicated app: iClosed Notifications, NavaWilson workspace `T061ZJFUH5X`. Bot scopes: chat:write, users:read, users:read.email. No conversation-history or document scopes. Invite only to these channels:

- Audit completed or failed: #signingpackage, `C0C2TM67LFP`, requester mention.
- COO sent or uncertain delivery; failed COO processing: #coo, `C0C4RKGFY4W`, requester mention.
- Other intervention failures: #iclosed, `C0BUV1RNTMF`, Saru `U0629UW3YN4` plus requester, deduplicated.

Messages contain event, file number where available and an authenticated iClosed link. No client names, source contents, provider error text or attachments. Requesters resolve from the saved authenticated actor through the app account email to Slack, never a display-name guess.

The persistent `team-notifications` private document starts with an activation timestamp; existing historical terminal jobs are not broadcast. A 15-second cloud service scans committed audit, COO, runtime, client-email and portal receipts and approved-but-blocked file openings. Sending claims and provider timestamp/channel receipts are durable; worker restarts do not resend sent events. Unknown post outcomes are `uncertain` and require reconciliation rather than blind retry. Identity failures are `blocked`.

Set `ORCHESTRATOR_SLACK_ENABLED=true` and secret `ORCHESTRATOR_SLACK_BOT_TOKEN` in a reviewed environment profile. Keep dev disabled unless explicitly testing; dev messages carry [DEV TEST]. The token is never browser exposed or committed. Changing Slack/read markers never changes browser notification acknowledgements or email status.

A generic failure without an initiating human uses Saru as the operational requester. Credential/transport failures in the notification service itself must be monitored through worker health/logs, since an unavailable Slack connection cannot deliver its own alert.

## Verification and release

Run the isolated synthetic suite and TypeScript checks, then verify signed-in previews, provider-only internal email delivery, synthetic Slack routing/mentions and real portal readback on a disposable dev deal. Do not send client notices as smoke tests. A successful synthetic test does not establish live Slack or client portal delivery. The existing production client-send gate remains independent of enabling these integrations.
