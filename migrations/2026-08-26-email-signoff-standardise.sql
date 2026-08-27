-- Standardise every email sign-off on "Warm regards," + the logo
-- ---------------------------------------------------------------------------
-- Three things, across every row in `email_templates`:
--
--   1. One sign-off phrase. "Best regards," / "Kind regards," / "Regards," /
--      "Sincerely," all become "Warm regards,".
--   2. No text signature after it. The logo image already reads
--      "iClosed - POWERED BY NAVA WILSON", so a line saying "The iClosed Team"
--      under the sign-off is the firm name twice in three lines.
--   3. A sign-off on templates that have none, so every email closes the same
--      way rather than stopping dead on its last paragraph.
--
-- Both repos read these shared rows, so this covers the admin app and the
-- customer portal at once, with no deploy.
--
-- SCOPE NOTE. Pass 3 only adds a sign-off to templates that already carry the
-- logo. That is deliberate and it draws the right line by itself: the branded
-- footer is what makes a template client-facing, so the internal staff alerts
-- (clerk documents, all-tasks-complete, deposit proof) are left alone - a
-- "Warm regards," on a back-office notification reads oddly. Pass 1 still
-- normalises their wording if they happen to sign off at all, which is harmless.
--
-- Pass 4 is separate because it changes two templates that this repo seeded
-- WITHOUT a logo at all (the deposit-task pair, added 2026-08-26). They would
-- otherwise be the only client emails with no branding. Drop pass 4 if you would
-- rather leave them plain.
--
-- Idempotent throughout: re-running finds every template already conformed.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Before-picture: the tail of every template, which is where all of this lives.
SELECT name, right(body, 320) AS tail
  FROM email_templates
 ORDER BY name;


-- ---------------------------------------------------------------------------
-- Pass 1: one sign-off phrase
-- ---------------------------------------------------------------------------
-- A single pattern handles the qualifier and the bare word together, so it
-- cannot run twice over its own output - replacing "Best regards," first and
-- then hunting "Regards," separately would match the "regards," inside the
-- "Warm regards," just written. \m anchors to a word start so "disregards" and
-- the like are untouched.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '\m(?:(?:warm|best|kind|with)\s+)?regards\s*,',
         'Warm regards,',
         'gi'
       )
 WHERE body ~* '\m(?:(?:warm|best|kind|with)\s+)?regards\s*,'
   AND body !~ 'Warm regards,';

UPDATE email_templates
   SET body = regexp_replace(body, '\msincerely\s*,', 'Warm regards,', 'gi')
 WHERE body ~* '\msincerely\s*,';


-- ---------------------------------------------------------------------------
-- Pass 2: drop the text signature under the sign-off
-- ---------------------------------------------------------------------------
-- Scoped to names that are the FIRM - iClosed / Nava Wilson - so a template
-- signed by an actual person keeps their name. Two shapes, because the name may
-- sit after a <br> in the same paragraph or in its own paragraph.

-- 2a. "Warm regards,<br>The iClosed Team"
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(Warm regards,)\s*<br\s*/?>\s*(?:The\s+)?(?:iClosed|Nava\s*Wilson)[^<]*',
         '\1',
         'gi'
       )
 WHERE body ~* '(Warm regards,)\s*<br\s*/?>\s*(?:The\s+)?(?:iClosed|Nava\s*Wilson)';

-- 2b. "<p>Warm regards,</p><p>The iClosed Team</p>"
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(Warm regards,\s*</p>)\s*<p[^>]*>\s*(?:The\s+)?(?:iClosed|Nava\s*Wilson)[^<]*</p>',
         '\1',
         'gi'
       )
 WHERE body ~* '(Warm regards,\s*</p>)\s*<p[^>]*>\s*(?:The\s+)?(?:iClosed|Nava\s*Wilson)';


-- ---------------------------------------------------------------------------
-- Pass 3: add a sign-off where there is none
-- ---------------------------------------------------------------------------
-- Inserted immediately before the logo, so it reads "Warm regards," then the
-- mark - the arrangement the other templates already use. Guarded on the body
-- containing no "regards" at all, so a template that signs off in wording this
-- migration does not recognise is left for a human rather than given a second
-- sign-off.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(\s*(?:<br\s*/?>)?\s*<img[^>]*email-logo[^>]*>)',
         '<p style="margin: 24px 0 8px 0;">Warm regards,</p>\1',
         'i'
       )
 WHERE body ILIKE '%email-logo%'
   AND body !~* '\mregards\s*,';


-- ---------------------------------------------------------------------------
-- Pass 4: brand the two deposit-task emails
-- ---------------------------------------------------------------------------
-- These were seeded by 2026-08-26-deposit-funds-task.sql with no logo, so pass 3
-- skipped them. The logo URL is READ FROM AN EXISTING ROW rather than written
-- out here, because it points at whichever admin host this particular database
-- belongs to (devadmin.iclosed.ca on dev) - hardcoding it would put the dev host
-- into production mail.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(\s*)</div>\s*$',
         '\1  <p style="margin: 24px 0 8px 0;">Warm regards,</p>'
         || '\1  <img src="'
         || (SELECT substring(t.body from 'https?://[^"'']*email-logo[^"'']*')
               FROM email_templates t
              WHERE t.body ILIKE '%email-logo%'
              LIMIT 1)
         || '" alt="iClosed" width="100" style="display:block;margin-left:0;'
         || 'margin-right:auto;width:100px;max-width:100%;height:auto;border:0;" />'
         || '\1</div>',
         'i'
       )
 WHERE name ILIKE ANY (ARRAY['%Deposit Funds Task Added%', '%Deposit Proof Received%'])
   AND body NOT ILIKE '%email-logo%'
   AND body ~ '</div>\s*$'
   AND EXISTS (SELECT 1 FROM email_templates t WHERE t.body ILIKE '%email-logo%');


-- ---------------------------------------------------------------------------
-- Verify - every tail should end "Warm regards," then the logo, with no team line
-- ---------------------------------------------------------------------------
SELECT name,
       body ~ 'Warm regards,' AS has_signoff,
       body ILIKE '%email-logo%' AS has_logo,
       right(body, 320) AS tail
  FROM email_templates
 ORDER BY name;
