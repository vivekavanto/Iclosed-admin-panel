-- Reword the "Deposit Funds Task Added" client email
-- ---------------------------------------------------------------------------
-- Three changes, all requested by the firm:
--
--   1. Lead with the two attachments. The email now carries the firm's Funds
--      Transfer Instructions PDF alongside the Final Statement of Account (see
--      sendDepositTaskEmail.ts + assets/funds-transfer-instructions.pdf), so the
--      body no longer says the instructions are "shown on the task itself".
--   2. Say plainly what the client must do next - log in and upload proof of
--      deposit - instead of the generic "a new task was added".
--   3. Drop the file number. It means nothing to a purchaser; it stays on the
--      staff-facing emails ("Deposit Proof Received" and the notifications),
--      which are NOT touched here.
--
-- The greeting moves from {{ client_name }} (first names) to {{ client_names }}
-- (full names), which is what the firm asked for. Both placeholders are resolved
-- by sendDepositTaskEmail.ts, so an un-migrated database still renders.
--
-- The matching wording is duplicated in fallbackBody() in
-- src/lib/sendDepositTaskEmail.ts. That fallback only runs when this row is
-- missing, inactive or empty - but the two must not drift, or a client could
-- tell which one they got. Change both together.
--
--
-- NOTE ON `is_deleted IS NOT TRUE` (do not simplify to `= false`):
-- email_templates.is_deleted is NULLABLE and is NULL on almost every row - 28
-- of 30 on dev, including the row this file targets. `is_deleted = false`
-- evaluates to NULL for those, not TRUE, so the UPDATE would match ZERO rows
-- and report "Success. No rows returned" - a silent no-op that looks exactly
-- like a successful run. Every other table in this schema has is_deleted
-- properly defaulted, which is why the same predicate is safe elsewhere; this
-- one table is the exception. The application code is unaffected: it filters
-- in JS with `!t.is_deleted`, where NULL is correctly falsy.
-- Apply in the Supabase SQL editor. Idempotent: safe to re-run. Plain ASCII,
-- no BEGIN/COMMIT wrapper, matching the 2026-08-26 batch.
--
-- !! WHEN THE SUPABASE EDITOR ASKS ABOUT ROW LEVEL SECURITY, CHOOSE
-- !! "Run without RLS".
--
-- The editor's linter reads the words "Into Our" inside the task name
-- 'Deposit Funds Into Our Trust Account' as SELECT ... INTO and concludes this
-- creates a table called "Our". It does not - every statement below is an
-- UPDATE against email_templates. Choosing "Run and enable RLS" appends
-- ALTER TABLE "Our" ENABLE ROW LEVEL SECURITY and fails the run with
-- ERROR: 42P01: relation "Our" does not exist.


-- ---------------------------------------------------------------------------
-- 1. Subject
-- ---------------------------------------------------------------------------
-- Unchanged in words; normalised to the em dash the code fallback uses, so the
-- DB-rendered and fallback subjects are byte-identical. chr(8212) rather than a
-- literal, to keep this file ASCII.

UPDATE email_templates
   SET subject = 'New task added on iClosed ' || chr(8212)
                 || ' Deposit Funds Into Our Trust Account'
 WHERE name ILIKE '%Deposit Funds Task Added%'
   AND is_deleted IS NOT TRUE;


-- ---------------------------------------------------------------------------
-- 2. Body
-- ---------------------------------------------------------------------------
-- The sign-off block is appended rather than written inline: the logo URL points
-- at whichever admin host THIS database belongs to (devadmin.iclosed.ca on dev),
-- so it is read from an existing template row - hardcoding it here would put the
-- dev host into production mail. Same technique as
-- 2026-08-26-email-signoff-standardise.sql pass 4.
--
-- COALESCE guards the case where no row carries a logo yet: without it the
-- concatenation would evaluate to NULL and blank the body entirely.

UPDATE email_templates
   SET body =
'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_names }},</p>
  <p>
    Please see attached your Final Statement of Account, along with instructions
    on how to deposit funds into our trust account. Once you&rsquo;ve deposited,
    <strong>please log into iClosed to upload your proof of deposit.</strong>
  </p>
  <p style="margin:0 0 4px;"><strong>Balance due on closing:</strong> {{ balance_due }}</p>
  <p style="margin:0 0 4px;"><strong>Property:</strong> {{ property_address }}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> {{ closing_date }}</p>
  <p style="margin-top:24px;">
    <a href="{{ portal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open iClosed
    </a>
  </p>
  <p style="margin: 24px 0 8px 0;">Warm regards,</p>
'
     || COALESCE(
          '  <img src="'
          || (SELECT substring(t.body from 'https?://[^"'']*email-logo[^"'']*')
                FROM email_templates t
               WHERE t.body ILIKE '%email-logo%'
                 AND t.is_deleted IS NOT TRUE
               LIMIT 1)
          || '" alt="iClosed" width="100" style="display:block;margin-left:0;'
          || 'margin-right:auto;width:100px;max-width:100%;height:auto;border:0;" />
',
          '')
     || '</div>'
 WHERE name ILIKE '%Deposit Funds Task Added%'
   AND is_deleted IS NOT TRUE;


-- ---------------------------------------------------------------------------
-- 3. Verify
-- ---------------------------------------------------------------------------
-- Expect one row: new copy present, no file number, sign-off and logo intact.

SELECT name,
       subject,
       body ILIKE '%upload your proof of deposit%' AS has_new_copy,
       body ILIKE '%{{ client_names }}%'           AS greets_full_names,
       body ILIKE '%file_number%'                  AS still_has_file_number,
       body ILIKE '%Warm regards%'                 AS has_signoff,
       body ILIKE '%email-logo%'                   AS has_logo
  FROM email_templates
 WHERE name ILIKE '%Deposit Funds Task Added%'
   AND is_deleted IS NOT TRUE;
