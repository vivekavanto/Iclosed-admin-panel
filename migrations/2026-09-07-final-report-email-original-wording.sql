-- Final reporting package email: back to the firm's original letter wording,
-- with the package still delivered as a DOWNLOAD LINK (never an attachment).
--
-- WHY
-- 2026-09-03 moved this email off attachments and, on the way past, rewrote the
-- body around the mechanics of that move ("…is now ready", "As these documents
-- are too large to send as an email attachment…", plus a line about the client
-- portal). That is the firm explaining its plumbing to a client. The letter the
-- firm actually sends reads:
--
--   Dear …,
--   Please find enclosed our final reporting package for your transaction at …
--   This package contains copies of the relevant closing documents for your
--   records. Kindly retain these in a safe place, as they may be required for
--   future reference.
--   Should you have any questions regarding the enclosed documents, please do
--   not hesitate to contact our office.
--   It has been a pleasure to act on your behalf.
--
-- This restores exactly those paragraphs and keeps ONLY the download button (and
-- its copy-paste fallback line) as the enclosure. Nothing else about the send
-- changes: same subject, same {{ download_link }} placeholder the shipped code
-- already resolves, same 180-day token, same 30 MB upload ceiling.
--
-- SAFE TO RUN ANY TIME — it introduces no new placeholder. {{ download_link }},
-- {{ user.first_name }} and {{ lead_address }} all resolve in the build that is
-- already live (sendFinalReportEmail.ts), so there is no window where a client
-- could receive literal "{{ … }}" text. (Contrast 2026-09-03, which had to be
-- run in two parts around its deploy.)
--
-- THE LOGO IS PRESERVED, NOT REWRITTEN. The brand lockup is an <img> literal in
-- this row pointing at the admin app's own /public — and its host differs per
-- environment. The UPDATE therefore rewrites everything ABOVE the image and
-- splices the row's OWN <img> tag back on, so a prod row never gets repointed at
-- the dev host. emailBrand.ts still swaps the filename per firm at send time.
--
-- Idempotent, and it will not clobber a later hand-edit: guarded on the 09-03
-- sentence it is replacing, so a second run — or a row staff have since reworded
-- in Templates → Emails — matches nothing.

UPDATE email_templates t
   SET body =
        E'<p>Dear {{ user.first_name }},</p>\n\n'
     || E'<p>Please find enclosed our final reporting package for your transaction at {{ lead_address }}.</p>\n\n'
     || E'<p style="margin: 24px 0;">\n  <a href="{{ download_link }}" style="background-color:#C10007;color:#ffffff;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;display:inline-block;">Download my final reporting package</a>\n</p>\n\n'
     || E'<p style="font-size:13px;color:#64748b;">If the button does not work, copy and paste this link into your browser:<br /><a href="{{ download_link }}" style="color:#C10007;word-break:break-all;">{{ download_link }}</a><br />This secure link remains active for 180 days.</p>\n\n'
     || E'<p>This package contains copies of the relevant closing documents for your records. Kindly retain these in a safe place, as they may be required for future reference.</p>\n\n'
     || E'<p>Should you have any questions regarding the enclosed documents, please do not hesitate to contact our office.</p>\n\n'
     || E'<p>It has been a pleasure to act on your behalf.</p><p style="margin: 24px 0 2px 0;">Warm regards,</p>\n\n'
     || COALESCE(
          substring(t.body from '<img[^>]*>'),
          '<img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed" width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />'
        )
 WHERE t.name ILIKE '%Final Reporting Package%'
   AND COALESCE(t.is_deleted, false) = false
   AND t.body ILIKE '%too large to send as an email attachment%';


-- ---------------------------------------------------------------------------
-- Verification (optional - run separately)
-- ---------------------------------------------------------------------------
-- SELECT name, is_active,
--        body ILIKE '%Please find enclosed%'  AS has_original_wording,
--        body ILIKE '%download_link%'         AS has_link_placeholder,
--        substring(body from '<img[^>]*>')    AS logo_tag
--   FROM email_templates
--  WHERE name ILIKE '%Final Reporting Package%';
