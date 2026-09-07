-- Emailed document links: a fifth invitation_tokens type, 'doc_link'.
--
-- WHY
-- The clerk email attaches every document on a file until the attachment budget
-- is spent and lists the rest as links (familyDocuments.ts). Those links were
-- built with docDownloadHref(), which for a private blob is
-- /api/admin/documents/download?u=… — an ADMIN route. middleware.ts gates it on
-- an admin session cookie, so a clerk clicking one from their inbox got
--
--   {"success":false,"error":"Unauthorized"}
--
-- The one part of the email that mattered most — the document that did NOT
-- arrive as an attachment — was the one part that did not work.
--
-- Those links are now tokenised: one invitation_tokens row per email, listing
-- the exact blob URLs it may serve in user_data, opened at the public route
-- /api/document-link/download (see src/lib/documentLink.ts). It grants nothing
-- the same email did not already grant — that email is carrying fifteen of these
-- documents as attachments — and it keeps the bytes in our own Blob store rather
-- than copying client identification onto a third-party drive.
--
-- ⚠ RUN THIS BEFORE (or with) THE DEPLOY. The token INSERT fails against the old
-- constraint. The code is written to survive that — createDocumentLink() catches
-- the error, logs it, and the email falls back to the old admin-proxy links with
-- every attachment still in place — so the gap costs nothing but the fix itself.
-- Running it early is equally harmless: no existing code writes this type.
--
-- The original constraint was created inline in 2026-05-19-create-invitation-
-- tokens.sql and last widened on 2026-09-03 (for 'final_report'), so Postgres
-- named it invitation_tokens_type_check. Drop by that conventional name and
-- re-add the widened version.
--
-- Idempotent: safe to re-run.

ALTER TABLE invitation_tokens
  DROP CONSTRAINT IF EXISTS invitation_tokens_type_check;

ALTER TABLE invitation_tokens
  ADD CONSTRAINT invitation_tokens_type_check
  CHECK (type IN ('invite', 'recovery', 'retainer_sign', 'final_report', 'doc_link'));


-- ---------------------------------------------------------------------------
-- Verification (optional - run separately)
-- ---------------------------------------------------------------------------
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'invitation_tokens_type_check';
-- SELECT type, count(*), max(created_at) FROM invitation_tokens GROUP BY type;
