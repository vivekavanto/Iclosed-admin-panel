-- "Email to Clerk" now sends two COMBINED PDFs
-- ---------------------------------------------------------------------------
-- The conveyancing clerk asked for the per-person paperwork merged: all of the
-- file's identification in ONE pdf and all of its personal information in
-- another, instead of a separate attachment per person. src/lib/clerkCombinedDocs.ts
-- builds them and src/lib/sendClerkDocumentsEmail.ts attaches them; every other
-- document (APS, mortgage, insurance…) still travels as its own original file.
--
-- That makes one sentence in the seeded template row wrong — it promises
-- "{{ attached_count }} documents are attached as separate files". The code now
-- APPENDS a generated "Attached:" breakdown after the body (merged PDFs first,
-- then the count of separate files), the same way the "too large to attach" list
-- is appended, so the sentence is simply removed rather than replaced with a new
-- placeholder.
--
-- ⚠️ RUN THIS AFTER the matching deploy. Not because it would break anything —
-- removing a line never does — but the generated breakdown only appears once the
-- new code is live, and until then the body would describe nothing.
--
-- SAFE TO SKIP: the row is optional. Delete or deactivate it and the send falls
-- back to the built-in body in sendClerkDocumentsEmail.ts, which is already
-- correct.
--
-- Placeholders resolved by src/lib/sendClerkDocumentsEmail.ts — the list from
-- 2026-08-18-clerk-documents-email-template.sql plus three new ones:
--   {{ identification_count }} ID documents merged into the combined PDF
--   {{ personal_info_count }}  parties whose details are in the combined PDF
--   {{ separate_count }}       documents still attached individually
--   {{ attached_count }}       every attachment on the email, merged PDFs included
-- Only add these to the body AFTER this migration's deploy is live everywhere —
-- a placeholder the running code doesn't know renders as literal "{{ }}" text.

UPDATE email_templates
   SET body = replace(
         body,
         '<p>{{ attached_count }} documents are attached as separate files.</p>',
         ''
       )
 WHERE name ILIKE '%Client Documents to Clerk%'
   AND body LIKE '%{{ attached_count }} documents are attached as separate files.%';

-- The seeded body indents its tags, so catch that shape too.
UPDATE email_templates
   SET body = regexp_replace(
         body,
         '\s*<p>\{\{ attached_count \}\} documents are attached as separate files\.</p>',
         '',
         'g'
       )
 WHERE name ILIKE '%Client Documents to Clerk%'
   AND body LIKE '%attached_count }} documents are attached as separate files%';

-- Verification — the sentence should be gone, everything else untouched.
SELECT id, name, is_active, deleted,
       body LIKE '%attached as separate files%' AS still_has_old_sentence
  FROM email_templates
 WHERE name ILIKE '%Client Documents to Clerk%';
