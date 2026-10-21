# Legal Assistant

The Orchestrator is integrated as the **Legal Assistant** navigation item in Admin at `/admin/legal-assistant`. It includes the Closer register, file detail and Drive links, signing-audit review, overall feedback, COO review, shared municipality contacts and manual mortgage-instructions timestamps. It uses the existing Admin shell and login, not an iframe or a second deployed application.

## Routes and access

UI routes are under `/admin/legal-assistant` and APIs under `/api/admin/legal-assistant`, both protected by the existing Admin middleware. The module's server authorization matches this dev branch's `app_metadata.role === "admin"` rule. No customer, confirmed-domain-only staff account, or new API exception is admitted by this change. Broader clerk permissions need a separate coordinated roster/AuthProvider/middleware change. Existing messaging, reminder and other Admin features remain intact.

## Local and hosted configuration

Local acceptance testing reuses the existing private Closer/Drive/mailbox configuration and private local state through an ignored `.env.local`. No secrets, mailbox tokens, client register, historical reports or client PDFs are committed. Standalone Operations source remains intact as a backup, not a deployment dependency.

This merge does not make the workflow backend production-ready. Local job/settings/token storage refuses production mode. Hosted dev must have persistent database/blob/token adapters and a separately configured isolated worker before real audits can run. Review the additive register SQL in `docs/legal-assistant-schema` and apply it manually only after approval; no migration is run by this integration. This does not alter the existing deal, lead or client schema. Without backend configuration the dashboard displays a connection notice and real audit submissions remain disabled. Sending and Drive packet filing remain disabled.

Set `ORCHESTRATOR_APP_URL` to the Admin origin. New mailbox sign-ins need `<admin-origin>/api/admin/legal-assistant/mailbox/callback` registered on the existing OAuth web client. The callback is excluded from request logs. Existing refresh-token permissions are unchanged; this integration grants no new scopes. The machine-refresh API is still behind Admin middleware; configure an authenticated scheduler design before activation rather than making an unauthenticated exception.

COO is manually triggered only when the clerk is finished and the final registered deed is available. Rendering is deterministic and unsigned. An isolated Python runtime with the pinned `scripts/coo/requirements.txt` dependencies is required; template assets are explicitly traced. The existing OpenAI/Drive-write acceptance gates are retained.

Contacts use revision checks and retain edit history. Mortgage timestamps come from the server and preserve the first click independently of Closer re-imports. Overall audit comments are append-only and retained for review before shared audit rules change; no automatic suppression or model training is claimed.

## Validation

Use the existing Admin `npm test`, `npx tsc --noEmit`, `npm run lint`, and `npm run build` commands. Imported module tests live under `tests/legal-assistant`, use synthetic temporary data and do not send email, invoke paid AI or change client documents. An access regression test confirms the existing Admin role is required. Real client data stays behind staff authentication; the module's illustrative previews are also behind Admin middleware.
