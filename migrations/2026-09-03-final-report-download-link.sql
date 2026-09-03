-- Final reporting package: 30 MB uploads, delivered as a download link.
--
-- WHY
-- A final reporting package is a scanned bundle and 15-25 MB is its NORMAL
-- size. Two things blocked that:
--
--   1. the upload cap. Every document uploaded under MAX_DOCUMENT_UPLOAD_BYTES
--      (10 MB), which Vercel Blob enforces on the PUT itself — so an oversized
--      package failed before any of our code ran, and the admin saw an opaque
--      "token" error. The app now uses MAX_FINAL_REPORT_BYTES (30 MB) for
--      doc_type = 'final_report' only. No schema change: the ceiling is code.
--
--   2. the email. The package rode along as an ATTACHMENT, and base64 adds
--      ~37% on the wire against Gmail's 25 MB and Outlook's 20 MB limits — a
--      20 MB package is a bounce, or a silent drop. It now travels as a
--      tokenised download link instead, which is what this migration is for.
--
-- ⚠ RUN IN TWO PARTS, AROUND THE DEPLOY — the sections are not interchangeable:
--
--   section 1 (the CHECK)      BEFORE the deploy. The first "Email final
--                              report" click on the new build inserts an
--                              invitation_tokens row of type 'final_report',
--                              and the widened CHECK is what lets it. Running
--                              it early is harmless: no existing code writes
--                              that type.
--
--   sections 2-3 (the wording) AFTER the deploy is live. email_templates rows
--                              are shared and take effect instantly, so the
--                              moment the body mentions {{ download_link }} a
--                              build that does not yet resolve that token would
--                              mail the literal text "{{ download_link }}" to a
--                              client. Deploy first, then reword.
--
-- Nothing breaks in the gap between the two: on the new build a template that
-- has not been reworded yet still gets a working download button appended by
-- the sender (see section 2).

-- ---------------------------------------------------------------------------
-- 1. Allow a fourth invitation_tokens.type: 'final_report'
-- ---------------------------------------------------------------------------
-- The download link reuses the existing token machinery rather than a new
-- table. Its scope rides in the columns that are already there — user_data
-- (jsonb: { kind:'final_report', deal_id, lead_ids, doc_ids }) names the exact
-- documents the token may open, so it can never reach another file's package
-- or, on a Purchase & Sale file, the other side's.
--
-- Note the token is NOT an auth token: /api/auth/activate now refuses every
-- type except 'invite' and 'recovery', so a download link that gets forwarded
-- can never be spent for a session on the client's portal account.
--
-- The original constraint was created inline in 2026-05-19-create-invitation-
-- tokens.sql, so Postgres named it invitation_tokens_type_check. Drop by that
-- conventional name and re-add the widened version.
--
-- Idempotent: safe to re-run.

ALTER TABLE invitation_tokens
  DROP CONSTRAINT IF EXISTS invitation_tokens_type_check;

ALTER TABLE invitation_tokens
  ADD CONSTRAINT invitation_tokens_type_check
  CHECK (type IN ('invite', 'recovery', 'retainer_sign', 'final_report'));


-- ---------------------------------------------------------------------------
-- 2. Reword the "Final Reporting Package" email — enclosure → download link
-- ---------------------------------------------------------------------------
-- The live body (created 2026-08-04) opens "Please find enclosed our final
-- reporting package…", which is no longer true: nothing is enclosed. This
-- rewrites it around {{ download_link }} — the new placeholder that resolves to
-- the recipient's OWN tokenised link (aliases download_url / report_link /
-- report_url / package_link / package_url / action_url / action_link /
-- button_url all resolve to the same URL, so staff can type whichever they are
-- used to).
--
-- What is deliberately PRESERVED from the existing row:
--   • the formal register ("Dear …", "Kindly retain these in a safe place",
--     "It has been a pleasure to act on your behalf") — this is the firm's
--     voice, not something to modernise on the way past;
--   • the sign-off block and the trailing <img> lockup EXACTLY as they are.
--     That img is the brand lockup emailBrand.ts rewrites per firm at send time
--     (it swaps the filename/width for Nava Wilson vs iClosed LLP), so its
--     shape must not drift. Same reason the subject line is left alone.
--
-- Guarded by `body NOT ILIKE '%download_link%'`, so it is idempotent and will
-- never overwrite a later hand-edit made in Templates → Emails.
--
-- Not urgent, only correct: until the placeholder is in the body, the sender
-- APPENDS a generated download button to the rendered email
-- (renderDownloadCtaHtml in sendFinalReportEmail.ts), so no client is ever sent
-- an email with no way to reach their package. Once it IS in the body, that
-- appended block switches itself off and the wording below is what goes out.

UPDATE email_templates
   SET body = E'<p>Dear {{ user.first_name }},</p>\n\n<p>Our final reporting package for your transaction at {{ lead_address }} is now ready.</p>\n\n<p>As these documents are too large to send as an email attachment, they are available to download securely using the button below:</p>\n\n<p style="margin: 24px 0;">\n  <a href="{{ download_link }}" style="background-color:#C10007;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Download my final reporting package</a>\n</p>\n\n<p style="font-size:13px;color:#64748b;">If the button does not work, copy and paste this link into your browser:<br /><a href="{{ download_link }}" style="color:#C10007;word-break:break-all;">{{ download_link }}</a><br />This secure link remains active for 180 days.</p>\n\n<p>This package contains copies of the relevant closing documents for your records. Kindly retain these in a safe place, as they may be required for future reference. They also remain available at any time in the Documents section of your client portal.</p>\n\n<p>Should you have any questions regarding these documents, please do not hesitate to contact our office.</p>\n\n<p>It has been a pleasure to act on your behalf.</p><p style="margin: 24px 0 2px 0;">Warm regards,</p>\n\n<img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />'
 WHERE name ILIKE '%Final Reporting Package%'
   AND COALESCE(is_deleted, false) = false
   AND body NOT ILIKE '%download_link%';


-- ---------------------------------------------------------------------------
-- 3. Seed the template IF the row is missing entirely
-- ---------------------------------------------------------------------------
-- The send refuses to run without an active template of this name, so this is
-- a safety net for a fresh environment — where a row exists (every environment
-- today) it does nothing, and section 2 is the part that matters.
--
-- The logo URL below matches the existing row's. On an environment whose admin
-- app is served from a different host, fix the src after seeding: it is a
-- literal in the template HTML, not something the send code injects.

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Final Reporting Package',
  'Final Reporting Package — {{ lead_address }}',
  E'<p>Dear {{ user.first_name }},</p>\n\n<p>Our final reporting package for your transaction at {{ lead_address }} is now ready.</p>\n\n<p>As these documents are too large to send as an email attachment, they are available to download securely using the button below:</p>\n\n<p style="margin: 24px 0;">\n  <a href="{{ download_link }}" style="background-color:#C10007;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Download my final reporting package</a>\n</p>\n\n<p style="font-size:13px;color:#64748b;">If the button does not work, copy and paste this link into your browser:<br /><a href="{{ download_link }}" style="color:#C10007;word-break:break-all;">{{ download_link }}</a><br />This secure link remains active for 180 days.</p>\n\n<p>This package contains copies of the relevant closing documents for your records. Kindly retain these in a safe place, as they may be required for future reference. They also remain available at any time in the Documents section of your client portal.</p>\n\n<p>Should you have any questions regarding these documents, please do not hesitate to contact our office.</p>\n\n<p>It has been a pleasure to act on your behalf.</p><p style="margin: 24px 0 2px 0;">Warm regards,</p>\n\n<img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Final Reporting Package%'
);


-- ---------------------------------------------------------------------------
-- Verification (optional - run separately)
-- ---------------------------------------------------------------------------
-- SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'invitation_tokens_type_check';
-- SELECT name, is_active, body ILIKE '%download_link%' AS has_link_placeholder
--   FROM email_templates WHERE name ILIKE '%Final Reporting Package%';
-- SELECT type, count(*) FROM invitation_tokens GROUP BY type;
