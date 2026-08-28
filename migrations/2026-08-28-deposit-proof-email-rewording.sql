-- Reword the "Deposit Proof Received" clerk email
-- ---------------------------------------------------------------------------
-- The staff-facing alert fired when a client uploads their proof of deposit.
-- Requested changes:
--
--   1. "Hi," -> "Hi Team,".
--   2. Lead with the FACT rather than the paperwork: the client deposited an
--      amount, not "uploaded proof of deposit".
--   3. Relabel "Balance due on closing" as "Deposit amount" - by the time this
--      email exists the money is in, so calling it a balance due is wrong.
--   4. Add a "File number:" row and change the CTA to "Open file on iClosed".
--
-- The file number STAYS on this email, unlike the client-facing
-- 2026-08-28-deposit-task-email-rewording.sql. Clerks work by file number.
--
-- ONE DELIBERATE DEVIATION from the wording as specified: the spec read
-- "<names> have deposited". "have" is wrong on the many files with a single
-- purchaser, and this template cannot branch. The past tense "deposited" is
-- correct for both ("Aliya Test deposited $X" / "Aliya Test and Aliya
-- Copurchaser deposited $X"), so that is what is used. Say the word if you want
-- the literal "have deposited" instead.
--
-- NO NEW PLACEHOLDERS are introduced. Every token below - client_names,
-- balance_due, transaction, closing_date, file_number, deal_url - is already
-- resolved by the CURRENTLY DEPLOYED sendDepositProofEmail.ts, so this row can
-- be applied before or after the code deploy without a placeholder ever
-- rendering literally in a clerk's inbox. That ordering-independence is worth
-- preserving on any future edit to this row.
--
-- The matching wording is duplicated in fallbackBody() in
-- src/lib/sendDepositProofEmail.ts, which additionally handles the case where
-- the attachment could not be downloaded (this row cannot branch, so it always
-- claims the document is attached - the same assumption the row it replaces
-- made). Change both together.
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
-- !! "Run without RLS". Every statement here is an UPDATE; nothing creates a
-- !! table. See 2026-08-26-deposit-funds-task.sql for why the editor asks.


-- ---------------------------------------------------------------------------
-- 1. Body
-- ---------------------------------------------------------------------------
-- The sign-off logo URL is read from an existing row rather than written out:
-- it points at whichever admin host THIS database belongs to (devadmin on dev),
-- so a literal would put the dev host into production mail. COALESCE guards the
-- case where no row carries a logo - without it the concatenation would
-- evaluate to NULL and blank the body entirely.

UPDATE email_templates
   SET body =
'<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi Team,</p>
  <p>
    <strong>{{ client_names }}</strong> deposited <strong>{{ balance_due }}</strong> for
    {{ transaction }}. The document is attached.
  </p>
  <p style="margin:0 0 4px;"><strong>Deposit amount:</strong> {{ balance_due }}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> {{ closing_date }}</p>
  <p style="margin:0 0 4px;"><strong>File number:</strong> {{ file_number }}</p>
  <p style="margin-top:24px;">
    <a href="{{ deal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open file on iClosed
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
 WHERE name ILIKE '%Deposit Proof Received%'
   AND is_deleted IS NOT TRUE;


-- ---------------------------------------------------------------------------
-- 2. Verify
-- ---------------------------------------------------------------------------
-- Expect one row with every flag TRUE except old_wording, which must be FALSE.

SELECT name,
       subject,
       body ILIKE '%Hi Team,%'                  AS greets_team,
       body ILIKE '%Deposit amount:%'           AS has_deposit_amount,
       body ILIKE '%File number:%'              AS has_file_number,
       body ILIKE '%Open file on iClosed%'      AS has_new_cta,
       body ILIKE '%Warm regards%'              AS has_signoff,
       body ILIKE '%email-logo%'                AS has_logo,
       (body ILIKE '%uploaded proof of deposit%'
        OR body ILIKE '%Balance due on closing%') AS old_wording
  FROM email_templates
 WHERE name ILIKE '%Deposit Proof Received%'
   AND is_deleted IS NOT TRUE;
