-- Drop the firm-name line under "Warm regards," and leave the logo alone.
-- ---------------------------------------------------------------------------
-- Client emails currently close like this:
--
--     Warm regards,
--     iClosed by Nava Wilson          <- this line
--     [ iClosed logo image ]
--
-- The logo artwork already reads "iClosed - POWERED BY NAVA WILSON", so the
-- line says the firm's name twice in two lines. 2026-08-26-email-signoff-
-- standardise.sql removed exactly this for the shapes it knew about, but its
-- pass 2 required the name to sit immediately inside the <p>:
--
--     <p[^>]*>\s*(?:The\s+)?(?:iClosed|Nava\s*Wilson)
--
-- The rows that survived wrap it in <strong> — "<p><strong>iClosed by Nava
-- Wilson</strong></p>" — so the pattern hit the tag, not the name, and the
-- UPDATE matched nothing. This finishes the job for the wrapped shapes.
--
-- ── SECOND REASON, NOW THAT FIRMS ARE A THING ──────────────────────────────
-- The line is hardcoded to ONE firm. Files retained by iClosed LLP send this
-- same template (the wording is shared; only the sender address and the logo
-- swap per firm — see src/lib/emailBrand.ts), so an iClosed LLP client has been
-- reading "iClosed by Nava Wilson" at the foot of their mail. Deleting the line
-- is what makes the template firm-neutral; the logo underneath is already
-- rewritten per firm at send time.
--
-- ── WHY THE MATCH IS ANCHORED ON THE SIGN-OFF ──────────────────────────────
-- "iClosed" appears in ordinary body copy too ("iClosed will be in touch"), and
-- a pattern loose enough to catch the signature would delete those sentences.
-- Both passes below therefore only ever remove a name that comes DIRECTLY after
-- "Warm regards," — the one position where it can only be a signature — and the
-- name itself is bounded to 40 characters so a stray paragraph cannot be
-- swallowed whole.
--
-- Both repos read these shared rows, so this covers the admin app and the
-- customer portal at once, with no deploy.
--
-- Idempotent: re-running finds nothing left to remove.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted — this
-- only updates existing rows.


-- Before-picture. Every row whose sign-off is followed by a firm name.
SELECT name, right(body, 260) AS tail
  FROM email_templates
 WHERE body ~* 'Warm regards,\s*(?:</p>\s*<p[^>]*>|<br\s*/?>)\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*(?:The\s+)?(?:iClosed|Nava\s*Wilson)'
 ORDER BY name;


-- ---------------------------------------------------------------------------
-- Pass 1: "<p>Warm regards,</p><p><strong>iClosed by Nava Wilson</strong></p>"
-- ---------------------------------------------------------------------------
-- The signature in its own paragraph, with or without a wrapper tag, and with
-- or without the margin style that 2026-09-02-email-logo-signoff-gap.sql added
-- to whichever paragraph sat closest to the logo.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(Warm regards,\s*</p>)\s*<p[^>]*>\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*'
         || '(?:The\s+)?(?:iClosed|Nava\s*Wilson)[^<]{0,40}'
         || '(?:\s*</(?:strong|b|em|span)>\s*)*</p>',
         '\1',
         'gi'
       )
 WHERE body ~* '(Warm regards,\s*</p>)\s*<p[^>]*>\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*(?:The\s+)?(?:iClosed|Nava\s*Wilson)';


-- ---------------------------------------------------------------------------
-- Pass 2: "<p>Warm regards,<br> iClosed by Nava Wilson</p>"
-- ---------------------------------------------------------------------------
-- Same line, same paragraph. This is 2026-08-26 pass 2a widened to allow the
-- <strong>/<b>/<em>/<span> wrapper it could not see.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(Warm regards,)\s*<br\s*/?>\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*'
         || '(?:The\s+)?(?:iClosed|Nava\s*Wilson)[^<]{0,40}'
         || '(?:\s*</(?:strong|b|em|span)>\s*)*',
         '\1',
         'gi'
       )
 WHERE body ~* '(Warm regards,)\s*<br\s*/?>\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*(?:The\s+)?(?:iClosed|Nava\s*Wilson)';


-- ---------------------------------------------------------------------------
-- Pass 3: keep the spacing tight
-- ---------------------------------------------------------------------------
-- "Warm regards," is now the paragraph directly above the logo, and it carries
-- the mail client's default bottom margin — roughly a full blank line between
-- the sign-off and the mark. 2026-09-02-email-logo-signoff-gap.sql pass 3 had
-- already trimmed the paragraph that used to sit there (the one just deleted),
-- so this re-applies the same rule to whatever paragraph the deletion promoted.
--
-- Only an UNSTYLED <p> is touched, exactly as that migration did, so a
-- deliberately styled paragraph is left as someone left it — which is also what
-- makes this safe to re-run.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '<p>((?:[^<]|<br\s*/?>|</?strong>)*)</p>(\s*)(<img[^>]*logo\.png[^>]*>)',
         '<p style="margin: 16px 0 4px 0;">\1</p>\2\3',
         'gi'
       )
 WHERE body ~* '<p>(?:[^<]|<br\s*/?>|</?strong>)*</p>\s*<img[^>]*logo\.png[^>]*>';


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- name_after_signoff must be false on every row: the sign-off should now be
-- followed by the logo and nothing else.
SELECT name,
       body ~* 'Warm regards,\s*(?:</p>\s*<p[^>]*>|<br\s*/?>)\s*(?:<(?:strong|b|em|span)[^>]*>\s*)*(?:The\s+)?(?:iClosed|Nava\s*Wilson)'
         AS name_after_signoff,
       right(body, 220) AS tail
  FROM email_templates
 ORDER BY name;

-- NOTE: migrations/2026-05-14-seed-welcome-template.sql still seeds the old
-- markup. It is guarded by NOT EXISTS, so it cannot re-add the line to a
-- database that already has a welcome row — but a brand-new environment seeded
-- from scratch would need this migration run after it.
