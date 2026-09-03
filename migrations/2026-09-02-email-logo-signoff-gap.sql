-- Close the gap between the sign-off and the logo in EVERY email
-- ---------------------------------------------------------------------------
-- Reported against "Retainer Agreement Signed", but it is not a retainer bug -
-- all 21 templates that carry the logo have the same markup and the same gap.
--
-- WHY THE 2026-08-26 LOGO MIGRATIONS DID NOT ALREADY FIX THIS
--
-- Every one of them matches `email-logo`:
--
--     <img[^>]*email-logo[^>]*>
--
-- but the rows in the database reference a different file:
--
--     <img src="https://iclosed-admin-panel.vercel.app/logo.png"
--          alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />
--
-- so those migrations matched nothing and silently no-opped - which is exactly
-- what they were written to do when the markup does not look as expected. The
-- patterns here key on `logo\.png` instead, which matches BOTH the current
-- /logo.png and the /email-logo.png the earlier migrations assumed, so this one
-- keeps working whichever file the rows end up pointing at.
--
-- WHAT MAKES THE GAP
--
-- Checked against all 21 rows; the tail is remarkably consistent:
--
--     <p>Best regards,</p>\n\n<br><img ... logo.png ... />
--                          ^^^^  ^^^^
--                          (2)   (1)
--
--   1. A literal <br> immediately before the <img>. Present in all 21 rows,
--      without exception. This is the big one - a whole blank line, ~25px at
--      the wrapper's line-height of 1.6.
--   2. The sign-off paragraph's default bottom margin, ~16px, because the <p>
--      carries no style of its own.
--
-- Together, ~40px of dead space between "Best regards," and the mark, which is
-- why the two read as unrelated blocks instead of one signature.
--
-- HOW
--
-- Pass 1 deletes the <br>. Pass 2 makes the img display:block so it still
-- starts on its own line now that the <br> is gone - without it, removing the
-- <br> would drag the logo up INLINE beside the sign-off text. Pass 3 trims the
-- paragraph margin above it from ~16px to 4px.
--
-- Deliberately NOT touching the logo size, alignment, or which box it lives in
-- - see the 2026-08-26 files for those, all of which need re-running against
-- `logo\.png` before they will do anything.
--
-- SCOPE: all templates, no name filter. "Fix it in all emails" was the ask, and
-- the markup is identical everywhere, so there is nothing to eyeball one email
-- at a time.
--
-- Both repos read these shared rows, so this covers the admin app and the
-- customer portal at once, with no deploy.
--
-- Idempotent: pass 1 finds no <br> left, passes 2 and 3 skip anything already
-- carrying the style they add.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- ---------------------------------------------------------------------------
-- Before-picture. 21 rows expected; the tail of each shows the <br><img> pair.
-- ---------------------------------------------------------------------------
SELECT name,
       right(body, 200) AS tail
  FROM email_templates
 WHERE body ~* '<img[^>]*logo\.png[^>]*>'
 ORDER BY name;


-- ---------------------------------------------------------------------------
-- Pass 1: drop the <br> above the logo
-- ---------------------------------------------------------------------------
-- The single biggest contributor - an entire blank line. Matches <br>, <br/>
-- and <br /> alike, and a run of several, should any row have more than one.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(?:<br\s*/?>\s*)+(<img[^>]*logo\.png[^>]*>)',
         '\1',
         'gi'
       )
 WHERE body ~* '<br\s*/?>\s*<img[^>]*logo\.png[^>]*>';


-- ---------------------------------------------------------------------------
-- Pass 2: put the logo on its own line without a <br>
-- ---------------------------------------------------------------------------
-- MUST run with pass 1. An <img> is inline: with the <br> gone and nothing
-- replacing it, the logo would sit on the same line as "Best regards,". The
-- 2px top margin is what is left of the gap.
--
-- Two passes because the img may or may not already carry a style attribute.
-- The declarations are PREPENDED so anything already in the attribute still
-- wins on conflict - notably the width:70px;height:auto; that sizes the mark.

-- 2a: the img already has a style attribute (all 21 rows today).
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?=[^>]*logo\.png)[^>]*?style\s*=\s*")',
         '\1display:block;margin:2px 0 0 0;',
         'gi'
       )
 WHERE body ~* '<img(?=[^>]*logo\.png)[^>]*?style\s*=\s*"'
   AND body !~* '<img(?=[^>]*logo\.png)[^>]*display\s*:\s*block';

-- 2b: the img has no style attribute at all. Add one just before the tag
-- closes, handling both ">" and "/>".
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?![^>]*style\s*=)(?=[^>]*logo\.png)[^>]*?)(\s*/?>)',
         '\1 style="display:block;margin:2px 0 0 0;"\2',
         'gi'
       )
 WHERE body ~* '<img(?![^>]*style\s*=)(?=[^>]*logo\.png)[^>]*>';


-- ---------------------------------------------------------------------------
-- Pass 3: trim the sign-off paragraph's bottom margin
-- ---------------------------------------------------------------------------
-- The <p> that ends immediately before the logo gets the mail client's default
-- margin, roughly a full line, which reopens most of the gap pass 1 just shut.
--
-- The paragraph is found by anchoring on the logo and reading BACKWARDS through
-- the tag that closes it. Its inner content is restricted to text plus <br> and
-- <strong> - deliberately, because that set cannot contain a '</p>', so the
-- match can never begin at an earlier paragraph and swallow the ones between.
-- That covers every shape in the rows today:
--
--     <p>Best regards,</p>
--     <p>Warm regards,<br> iClosed by Nava Wilson</p>
--     <p><strong>iClosed by Nava Wilson</strong></p>
--     <p>It has been a pleasure to act on your behalf.</p>
--
-- Only a <p> carrying no attributes is matched, so a paragraph someone styled
-- deliberately is left as they left it - and so re-running this is a no-op.
--
-- Three rows have the logo after a closing </div> rather than after a
-- paragraph, and two more have it after bare text or an unclosed <p>. Those
-- have no paragraph margin to trim, are already tight once pass 1 lands, and
-- are correctly left alone here.
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
-- still_has_br must be false on every row, and every logo tag must carry
-- display:block. The .{0,200} bound is capped deliberately: Postgres rejects a
-- regex repetition count above 255 with "invalid repetition count(s)"
-- (SQLSTATE 2201B). Use right(body, n) for a longer window.
SELECT name,
       body ~* '<br\s*/?>\s*<img[^>]*logo\.png'        AS still_has_br,
       body ~* '<img[^>]*logo\.png[^>]*display:block'  AS logo_is_block,
       right(body, 220)                                AS tail
  FROM email_templates
 WHERE body ~* '<img[^>]*logo\.png[^>]*>'
 ORDER BY name;
