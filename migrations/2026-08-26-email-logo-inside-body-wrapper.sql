-- Move the iClosed logo inside the email body wrapper
-- ---------------------------------------------------------------------------
-- SUPERSEDES 2026-08-26-email-logo-center-align.sql and
-- 2026-08-26-email-logo-left-align.sql. Both of those tried to fix the logo
-- position by styling the <img> itself. Neither could work, because the problem
-- was never the img alignment - it was which box the img lives in.
--
-- THE ACTUAL STRUCTURE (template "Sign Retainer")
--
--   <div style="max-width: 600px; margin: 0 auto; ...">   <- body copy column
--     ...greeting, paragraph, button, footnote...
--   </div>
--   <br><img src=".../email-logo.png" ... />              <- OUTSIDE the column
--
-- The body sits in a 600px column that `margin: 0 auto` centres in the email.
-- The logo is emitted AFTER that column closes, so it belongs to the full-width
-- card instead. `margin-left:0` therefore pinned it to the left edge of the
-- CARD, which is roughly 250px left of where the body copy starts - the gap in
-- the screenshots. Centring it (the first attempt) put it in the middle of the
-- card, which was wrong in the other direction.
--
-- THE FIX
--
-- Move the <br> and the <img> inside the wrapper, immediately before its
-- closing </div>. The logo then inherits the same 600px column as the copy and
-- lines up with it exactly - at any render width, on any client, with no
-- hardcoded offset to go stale.
--
-- "Retainer Agreement Signed" already has its img inside its wrapper, and that
-- wrapper has no max-width, so its logo was never misaligned. Pass 1 leaves it
-- alone; pass 2 only tidies its inline style.
--
-- Idempotent: pass 1 matches only a logo that is still outside the wrapper.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Before-picture: `outside_wrapper` = true is the row that needs moving.
SELECT id, name,
       body ~* '</div>\s*(<br\s*/?>)?\s*<img[^>]*email-logo[^>]*>\s*$' AS outside_wrapper,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE body ILIKE '%email-logo%';


-- Pass 1: move a trailing logo inside the wrapper it currently follows.
--
-- Anchored to the end of the body, so the </div> being matched is unambiguously
-- the closing tag of the wrapper and not one belonging to some nested block. The
-- capture keeps the <br> and the img byte-for-byte; only their position moves.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '</div>(\s*(?:<br\s*/?>)?\s*<img[^>]*email-logo[^>]*>\s*)$',
         '\1</div>',
         'i'
       )
 WHERE body ~* '</div>\s*(<br\s*/?>)?\s*<img[^>]*email-logo[^>]*>\s*$';


-- Pass 2: tidy the inline style the two superseded migrations left behind.
--
-- They prepended `display:block` to a style that already ended with one, so the
-- declaration appears twice. Harmless - same value both times - but it makes the
-- tag hard to read, and anyone editing it in Admin > Templates > Emails would
-- reasonably wonder which one is live. Collapse to a single leading declaration.
UPDATE email_templates
   SET body = replace(
         body,
         'height:auto;display:block;border:0;',
         'height:auto;border:0;'
       )
 WHERE body LIKE '%display:block;margin-left:0;%'
   AND body LIKE '%height:auto;display:block;border:0;%';


-- ---------------------------------------------------------------------------
-- Verify - `outside_wrapper` should now be false for every row
-- ---------------------------------------------------------------------------
SELECT id, name,
       body ~* '</div>\s*(<br\s*/?>)?\s*<img[^>]*email-logo[^>]*>\s*$' AS outside_wrapper,
       substring(body from '.{0,60}<img[^>]*email-logo[^>]*>.{0,20}') AS logo_context
  FROM email_templates
 WHERE body ILIKE '%email-logo%';
