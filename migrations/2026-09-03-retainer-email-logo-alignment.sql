-- Fix the "Sign Retainer" email's logo alignment
-- ---------------------------------------------------------------------------
-- The sign-off logo rendered hard against the LEFT EDGE of the email while the
-- body sat in its centred column, because the <img> was placed OUTSIDE the
-- container that centres everything else:
--
--   <div style="max-width:600px;margin:0 auto;">   <- the centred column
--     ...body...
--   </div>
--   <br><img src="..." />                          <- outside it, so unstyled
--                                                     by the column entirely
--
-- A block element after that </div> is laid out against the email body root,
-- which is full width. It therefore ignores both the 600px cap and the
-- `margin:0 auto` centring, and lands at x=0. Nothing about the <img>'s own CSS
-- was wrong - its POSITION in the tree was.
--
-- This moves the image INSIDE the closing </div> and gives it the same
-- display:block + left margin the other templates' sign-offs use (see
-- 2026-08-28-deposit-proof-email-rewording.sql), so it aligns with the body text
-- rather than the viewport.
--
-- The <img>'s src is CARRIED OVER from whatever the row already holds rather
-- than written out as a literal: it points at whichever admin host THIS database
-- belongs to, and a literal would put one environment's host into the other's
-- mail. Same reasoning as the 2026-08-28 migration.
--
-- The matching wording lives in scripts/seed-retainer-template.mjs - that script
-- REWRITES this row when it is run, so the two must be changed together or a
-- re-seed would undo this. Both were changed on 2026-09-03.
--
--
-- NOTE ON `is_deleted IS NOT TRUE` (do not simplify to `= false`):
-- email_templates.is_deleted is NULLABLE and NULL on almost every row.
-- `is_deleted = false` evaluates to NULL for those, not TRUE, so the UPDATE
-- would match ZERO rows and report "Success. No rows returned" - a silent no-op
-- that looks exactly like a successful run. See the 2026-08-28 migration for the
-- full write-up.
--
-- Apply in the Supabase SQL editor. Idempotent: the WHERE clause only matches a
-- body that still has the image outside the div, so re-running is a no-op.
--
-- !! WHEN THE SUPABASE EDITOR ASKS ABOUT ROW LEVEL SECURITY, CHOOSE
-- !! "Run without RLS". The statement below is an UPDATE; nothing creates a
-- !! table.


-- ---------------------------------------------------------------------------
-- 1. Move the logo inside the centred container
-- ---------------------------------------------------------------------------
-- Anchored to the END of the body ($) so it can only ever match the sign-off,
-- never an inline image earlier in the template. Capture group 1 is the existing
-- src, which is re-emitted unchanged.

UPDATE email_templates
   SET body = regexp_replace(
         body,
         '</div>\s*(?:<br\s*/?>\s*)*<img[^>]*src="([^"]+)"[^>]*>\s*$',
         '  <img src="\1" alt="iClosed by Nava Wilson" style="display:block;margin:32px 0 0 0;width:70px;max-width:100%;height:auto;border:0;" />'
         || chr(10) || '</div>',
         'i'
       )
 WHERE name ILIKE '%retainer%'
   AND name NOT ILIKE '%signed%'
   AND is_deleted IS NOT TRUE
   AND body ~* '</div>\s*(?:<br\s*/?>\s*)*<img[^>]*src="[^"]+"[^>]*>\s*$';


-- ---------------------------------------------------------------------------
-- 2. Verify
-- ---------------------------------------------------------------------------
-- Expect logo_inside_div = TRUE and logo_outside_div = FALSE on every row.

SELECT name,
       body ~* '<img[^>]*>\s*</div>\s*$'                                   AS logo_inside_div,
       body ~* '</div>\s*(?:<br\s*/?>\s*)*<img[^>]*>\s*$'                  AS logo_outside_div,
       body ILIKE '%display:block;margin:32px 0 0 0%'                      AS has_signoff_style
  FROM email_templates
 WHERE name ILIKE '%retainer%'
   AND name NOT ILIKE '%signed%'
   AND is_deleted IS NOT TRUE;
