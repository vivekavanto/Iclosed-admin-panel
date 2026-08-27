-- Centre the iClosed logo in the retainer emails
-- ---------------------------------------------------------------------------
-- !! SUPERSEDED by 2026-08-26-email-logo-left-align.sql. Centred was not what
-- !! was wanted - the logo should line up with the LEFT edge of the body copy.
-- !! Do NOT run this on a fresh database; run the left-align migration instead.
-- !! Kept only so the history of what was applied stays readable.
-- ---------------------------------------------------------------------------
-- The logo sits at the foot of the retainer emails hard against the left edge,
-- while the body copy sits in a centred column - so the mark looks detached
-- from the email it belongs to.
--
-- WHY THIS IS A MIGRATION AND NOT A CODE CHANGE
--
-- No send code injects the logo. It is an <img> inside the `body` HTML of the
-- `email_templates` rows themselves, pointing at /email-logo.png hosted by the
-- admin app itself. Both repos render those same rows out of the shared
-- database - the admin app sends "Sign Retainer" via src/lib/sendRetainerLink.ts
-- and the customer portal sends "Retainer Agreement Signed" via
-- src/lib/email-templates/retainer.ts - so editing the rows once fixes the email
-- in BOTH apps, and no deploy is involved.
--
-- HOW
--
-- The logo is centred by styling the <img> itself (display:block with auto side
-- margins) rather than by wrapping it in a new element. Wrapping would mean
-- guessing what the img currently sits inside: a <div> inserted into a <p> is
-- invalid HTML, and email clients disagree about how to recover from it.
-- Styling the tag in place cannot change the document structure.
--
-- Two passes are needed because the img may or may not already carry a `style`
-- attribute, and `src` may appear either before or after it. The lookaheads
-- scope both passes to img tags that reference the logo and nothing else.
--
-- Idempotent: both passes skip a tag that has already been centred.
--
-- Apply in the Supabase SQL editor. Choose "Run without RLS" if prompted - this
-- only updates existing rows.


-- Look first. This is the before-picture, and it also tells you whether the
-- markup matches what the UPDATEs below expect: if it returns no rows, the logo
-- is referenced some other way and the updates will no-op harmlessly.
SELECT id, name,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img[^>]*email-logo[^>]*>';


-- Pass 1: the img already has a style attribute. Prepend the centring
-- declarations so anything already there still wins on conflict.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?=[^>]*email-logo)[^>]*?style\s*=\s*")',
         '\1display:block;margin-left:auto;margin-right:auto;',
         'gi'
       )
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img(?=[^>]*email-logo)[^>]*?style\s*=\s*"'
   AND body !~* '<img(?=[^>]*email-logo)[^>]*margin-left\s*:\s*auto';


-- Pass 2: the img has no style attribute at all. Add one just before the tag
-- closes, handling both ">" and "/>".
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '(<img(?![^>]*style\s*=)(?=[^>]*email-logo)[^>]*?)(\s*/?>)',
         '\1 style="display:block;margin-left:auto;margin-right:auto;"\2',
         'gi'
       )
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img(?![^>]*style\s*=)(?=[^>]*email-logo)[^>]*>';


-- ---------------------------------------------------------------------------
-- Verify - every matching tag should now carry margin-left:auto
-- ---------------------------------------------------------------------------
SELECT id, name,
       substring(body from '<img[^>]*email-logo[^>]*>') AS logo_tag
  FROM email_templates
 WHERE name ILIKE '%retainer%'
   AND body ~* '<img[^>]*email-logo[^>]*>';


-- ---------------------------------------------------------------------------
-- Every other email has the same left-aligned logo, since the rows share the
-- markup. To centre the logo across ALL templates rather than just the retainer
-- ones, re-run the two UPDATEs above with the `name ILIKE '%retainer%'` line
-- removed from each. Deliberately not done here: only the retainer email was
-- asked for, and this way the change can be eyeballed in one email first.
-- ---------------------------------------------------------------------------
