-- Tighten the gap between "Warm regards," and the logo
-- ---------------------------------------------------------------------------
-- The sign-off and the mark below it read as two separate blocks rather than one
-- signature. Three things are stacking up to make the gap:
--
--   1. A literal <br> immediately before the <img>. This is the big one - it is
--      a whole blank line, and it is there in every template that was authored
--      with the logo appended by hand.
--   2. The bottom margin on the sign-off paragraph.
--   3. The paragraph default margin, on templates whose sign-off <p> carries no
--      style at all.
--
-- All three are addressed below. Nothing here touches the logo size - that lives
-- in 2026-08-26-email-logo-size.sql, which is re-runnable with a new target.
--
-- Both repos read these shared rows, so this covers the admin app and the
-- customer portal at once, with no deploy.
--
-- Idempotent: re-running finds nothing left to tighten.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Before-picture: the tail of every template carrying the logo.
SELECT name, right(body, 260) AS tail
  FROM email_templates
 WHERE body ILIKE '%email-logo%'
 ORDER BY name;


-- ---------------------------------------------------------------------------
-- Pass 1: drop the <br> above the logo
-- ---------------------------------------------------------------------------
-- Worth doing first and on its own: it removes an entire blank line, which is
-- most of the gap. Matches <br>, <br/> and <br /> alike.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '<br\s*/?>\s*(<img[^>]*email-logo[^>]*>)',
         '\1',
         'gi'
       )
 WHERE body ~* '<br\s*/?>\s*<img[^>]*email-logo[^>]*>';


-- ---------------------------------------------------------------------------
-- Pass 2: tighten the sign-off paragraph this repo inserted
-- ---------------------------------------------------------------------------
-- 2026-08-26-email-signoff-standardise.sql wrote `margin: 24px 0 8px 0;` on the
-- sign-off paragraphs it added. Exact-match replace, so it cannot disturb a
-- margin that happens to be similar elsewhere in the body.
UPDATE email_templates
   SET body = replace(
         body,
         '<p style="margin: 24px 0 8px 0;">Warm regards,</p>',
         '<p style="margin: 24px 0 2px 0;">Warm regards,</p>'
       )
 WHERE body LIKE '%<p style="margin: 24px 0 8px 0;">Warm regards,</p>%';


-- ---------------------------------------------------------------------------
-- Pass 3: tighten a bare sign-off paragraph
-- ---------------------------------------------------------------------------
-- A <p> with no style of its own gets the mail client default - roughly a full
-- line above and below - which reopens the gap pass 1 just closed. Only matches
-- a <p> carrying no attributes, so a paragraph someone deliberately styled is
-- left as they left it.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '<p>(\s*Warm regards,\s*)</p>',
         '<p style="margin: 24px 0 2px 0;">\1</p>',
         'gi'
       )
 WHERE body ~ '<p>\s*Warm regards,\s*</p>';


-- ---------------------------------------------------------------------------
-- Verify - the logo should now follow the sign-off with no <br> between them
-- ---------------------------------------------------------------------------
-- The .{0,200} bound is capped deliberately: Postgres rejects a regex
-- repetition count above 255 with "invalid repetition count(s)" (SQLSTATE
-- 2201B). Use right(body, n) if you ever need a longer window than that.
SELECT name,
       body ~* '<br\s*/?>\s*<img[^>]*email-logo' AS still_has_br,
       substring(body from 'Warm regards,.{0,200}') AS signoff_block
  FROM email_templates
 WHERE body ILIKE '%email-logo%'
 ORDER BY name;
