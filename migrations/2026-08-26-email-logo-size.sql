-- Shrink the iClosed logo in every email
-- ---------------------------------------------------------------------------
-- The logo renders at 140px wide, which sits heavier than the body copy around
-- it. This takes it to 85px across ALL templates - not just the retainer pair -
-- so the mark is consistent wherever it appears.
--
-- TO CHANGE THE SIZE LATER: edit the three occurrences of 85 below (the two
-- replacement values and the verification note). Nothing else references it -
-- the logo lives in the `email_templates` rows, not in either repo code, so
-- there is no constant to keep in step and no deploy involved. Both the admin
-- app and the customer portal read these same shared rows.
--
-- WHY BOTH THE ATTRIBUTE AND THE STYLE
--
-- The tag carries the width twice: `width="140"` and `width:140px` inside the
-- inline style. That duplication is deliberate and must be kept in step -
-- Outlook strips much of the CSS and falls back to the HTML attribute, so
-- updating only the style would leave the logo at its old size in exactly the
-- client most likely to show it wrong. Both passes below are therefore required.
--
-- The passes normalise ANY existing width to the target rather than swapping one
-- specific number, so a template that was hand-edited to some other size ends up
-- consistent with the rest instead of being silently skipped.
--
-- `height:auto` is already on the tag, so the image scales proportionally and
-- there is no height to adjust.
--
-- Idempotent: re-running finds every logo already at the target.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Before-picture: every template carrying the logo, and the size it renders at.
SELECT id, name,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE body ILIKE '%email-logo%';


-- Pass 1: the HTML width attribute (what Outlook uses).
--
-- The leading \s in the capture keeps this anchored to a real attribute
-- boundary, so it can only match `width=` and never the tail of some other
-- attribute name.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?=[^>]*email-logo)[^>]*?\s)width\s*=\s*"[0-9]+"',
         '\1width="85"',
         'gi'
       )
 WHERE body ~* '<img(?=[^>]*email-logo)[^>]*?\swidth\s*=\s*"[0-9]+"';


-- Pass 2: the CSS width in the inline style (what everything else uses).
--
-- The [;"\s] before `width` is load-bearing: without it the pattern would also
-- match the tail of `max-width:600px` and quietly rewrite the wrong declaration.
-- `max-width:100%` on the tag is left alone either way, since 100% is not a px
-- value - and it should stay, so the logo still shrinks on a narrow screen.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?=[^>]*email-logo)[^>]*?[;"\s])width\s*:\s*[0-9]+px',
         '\1width:85px',
         'gi'
       )
 WHERE body ~* '<img(?=[^>]*email-logo)[^>]*?[;"\s]width\s*:\s*[0-9]+px';


-- ---------------------------------------------------------------------------
-- Verify - every logo_tag should read width="85" and width:85px
-- ---------------------------------------------------------------------------
SELECT id, name,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE body ILIKE '%email-logo%';
