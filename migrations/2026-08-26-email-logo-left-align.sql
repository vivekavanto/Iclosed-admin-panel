-- Left-align the iClosed logo in the retainer emails
-- ---------------------------------------------------------------------------
-- !! SUPERSEDED by 2026-08-26-email-logo-inside-body-wrapper.sql - styling the
-- !! img could not fix this; the img is in the wrong container. Do not run.
-- SUPERSEDES 2026-08-26-email-logo-center-align.sql. That one centred the logo;
-- centred is not what was wanted. The logo should sit flush with the LEFT edge
-- of the body copy - lined up under "Hi <name>," and the paragraph text - rather
-- than centred, and rather than hanging further left than the content the way it
-- did originally.
--
-- Same reasoning as the migration it supersedes: no send code injects the logo,
-- it is an <img> inside the `body` HTML of the `email_templates` rows, and both
-- the admin app and the customer portal render those same shared rows. Editing
-- the rows fixes both apps with no deploy.
--
-- The img keeps `display:block` - that is what lets the side margins decide the
-- alignment at all - and swaps the two auto margins for `margin-left:0`, which
-- pins it to the left edge of its container. Styling stays on the tag itself so the
-- document structure is untouched.
--
-- Idempotent: re-running finds nothing left to change.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Before-picture, with enough surrounding markup to see which container the
-- logo actually sits in. If the logo still does not line up with the body after
-- this migration, that container is the reason - send this output on.
SELECT id, name,
       substring(body from '.{0,220}<img[^>]*email-logo[^>]*>.{0,120}') AS logo_context
  FROM email_templates
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img[^>]*email-logo[^>]*>';


-- Pass 1: undo the centring this repo applied earlier today. Targets the exact
-- declarations that migration inserted, so it cannot disturb anything else.
UPDATE email_templates
   SET body = replace(
         body,
         'display:block;margin-left:auto;margin-right:auto;',
         'display:block;margin-left:0;margin-right:auto;'
       )
 WHERE name ILIKE '%retainer%'
   AND body LIKE '%display:block;margin-left:auto;margin-right:auto;%';


-- Pass 2: any other way the logo may have been centred - a hand-edited
-- `margin:0 auto`, or auto margins written in the other order. Scoped by
-- lookahead to img tags that reference the logo.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?=[^>]*email-logo)[^>]*?)margin\s*:\s*0\s+auto\s*;?',
         '\1display:block;margin-left:0;margin-right:auto;',
         'gi'
       )
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img(?=[^>]*email-logo)[^>]*?margin\s*:\s*0\s+auto';

UPDATE email_templates
   SET body = replace(
         body,
         'margin-right:auto;margin-left:auto;',
         'margin-right:auto;margin-left:0;'
       )
 WHERE name ILIKE '%retainer%'
   AND body LIKE '%margin-right:auto;margin-left:auto;%';


-- Pass 3: a logo that was never touched by either migration and carries no
-- alignment styling at all. A block image defaults to the left edge of its container,
-- so state that explicitly rather than leaving it to the mail client defaults.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?![^>]*style\s*=)(?=[^>]*email-logo)[^>]*?)(\s*/?>)',
         '\1 style="display:block;margin-left:0;margin-right:auto;"\2',
         'gi'
       )
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img(?![^>]*style\s*=)(?=[^>]*email-logo)[^>]*>';


-- ---------------------------------------------------------------------------
-- Verify - every matching tag should read margin-left:0 and no auto left margin
-- ---------------------------------------------------------------------------
SELECT id, name,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img[^>]*email-logo[^>]*>';
