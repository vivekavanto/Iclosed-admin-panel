-- "Deposit Funds Into Our Trust Account" - the closing-funds task (Purchase)
-- ---------------------------------------------------------------------------
-- The last thing a purchaser has to do is send us the balance due on closing.
-- Until now that happened entirely over email. This adds it as a real task, but
-- one that CANNOT be shown to the client the moment the file is created: the
-- balance only exists once the firm has drawn up the Final Statement of Account,
-- which happens days before closing. So the task needs a third state - present
-- in the back office, invisible to the client - that an admin flips on by hand.
--
-- That state is expressed with two columns rather than a new tasks.status value:
--
--   tasks.activation_required  the task starts life switched OFF
--   tasks.activated_at         NULL until an admin activates it
--
-- A task is INACTIVE while activation_required AND activated_at IS NULL.
-- Inactive tasks are hidden from the customer portal and - importantly -
-- excluded from the milestone rollup and the "all tasks complete" alert. If they
-- were not, a file could never report itself finished, and the alert that tells
-- the firm to draw up the statement would never fire: a deadlock where the task
-- waits on the statement and the statement waits on the task.
--
-- Keeping status as only Pending or Completed also means every existing query,
-- badge and rollup keeps working untouched; "Inactive" is derived for display.
--
-- The other columns hold what the admin supplies before activating:
--   tasks.balance_due          the figure shown to the client in large type
-- The Final Statement of Account itself is a lead_corporate_docs row with
-- doc_type = 'statement_of_account', exactly like final_report - that gets it
-- into the admin Documents modal and the client portal Documents page for free.
--
-- Apply in the Supabase SQL editor. Idempotent: safe to re-run. Deliberately
-- plain ASCII with no BEGIN/COMMIT wrapper, so each section can be run on its
-- own if you would rather go one at a time.
--
-- !! WHEN THE SUPABASE EDITOR ASKS ABOUT ROW LEVEL SECURITY, CHOOSE
-- !! "Run without RLS".
--
-- It will claim "this query creates a table without enabling Row Level
-- Security ... may be able to access Our". It does not. The editor lints the
-- SQL with a naive parser that reads the words "Into Our" inside the task name
-- 'Deposit Funds Into Our Trust Account' as the SELECT ... INTO syntax that
-- creates a table, and concludes there is a new table called "Our". Every
-- statement below is an ALTER/INSERT/UPDATE against a table that already
-- exists; nothing here creates one, so there is no RLS decision to make.
--
-- Choosing "Run and enable RLS" instead makes the editor append
-- ALTER TABLE "Our" ENABLE ROW LEVEL SECURITY, which fails the whole run with
-- ERROR: 42P01: relation "Our" does not exist. That error is the editor's, not
-- this file's. Expect the prompt on any section that mentions the task by name.


-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS activation_required BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN task_templates.activation_required IS
  'Blueprint flag: tasks generated from this template start INACTIVE (hidden from the client) until an admin activates them. Copied onto tasks.activation_required at conversion.';

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS activation_required BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS balance_due NUMERIC NULL;

COMMENT ON COLUMN tasks.activation_required IS
  'This task is switched off at creation. INACTIVE while activation_required AND activated_at IS NULL: hidden from the customer portal and excluded from the milestone rollup and all-tasks-complete alert.';

COMMENT ON COLUMN tasks.activated_at IS
  'When an admin activated the task and the client was notified. NULL while inactive.';

COMMENT ON COLUMN tasks.balance_due IS
  'Balance due on closing, taken from the Final Statement of Account. Shown to the client in large type on the deposit task. NULL = not set (not zero).';


-- ---------------------------------------------------------------------------
-- 2. The task template
-- ---------------------------------------------------------------------------
-- Purchase side only, and SHARED: the balance is a property of the file, not of
-- each purchaser, so one row on the primary deal serves the whole family (see
-- findFamilySharedTaskPeers). Ordered last, and hung off the same stage as the
-- Home Insurance Policy task so it lands in the closing milestone rather than
-- floating with no milestone_id.
--
-- The literal flags below are, in order:
--   is_default          TRUE   seeded onto every new Purchase file
--   is_shared           TRUE   one per family, on the primary deal
--   is_aps_task         FALSE
--   activation_required TRUE   starts INACTIVE

INSERT INTO task_templates (
  lead_type, role_type, name, order_index,
  is_default, is_shared, is_aps_task, activation_required, stage_template_id
)
SELECT
  'Purchase',
  'Client',
  'Deposit Funds Into Our Trust Account',
  COALESCE(seed.max_order, 0) + 1,
  TRUE,
  TRUE,
  FALSE,
  TRUE,
  seed.stage_template_id
FROM (
  SELECT
    (SELECT MAX(order_index) FROM task_templates
      WHERE lead_type = 'Purchase' AND is_deleted = false) AS max_order,
    (SELECT stage_template_id FROM task_templates
      WHERE lead_type = 'Purchase' AND is_deleted = false
        AND name ILIKE 'Home Insurance Policy'
        AND stage_template_id IS NOT NULL
      LIMIT 1) AS stage_template_id
) AS seed
WHERE NOT EXISTS (
  SELECT 1 FROM task_templates
   WHERE is_deleted = false
     AND lower(trim(name)) = 'deposit funds into our trust account'
);

-- Re-running with the template already present must still repair the flags. A
-- hand-created row would not have them.
UPDATE task_templates
   SET activation_required = TRUE,
       is_shared = TRUE,
       is_default = TRUE
 WHERE is_deleted = false
   AND lower(trim(name)) = 'deposit funds into our trust account';


-- ---------------------------------------------------------------------------
-- 3. The one field the client fills in: proof of deposit
-- ---------------------------------------------------------------------------
-- Modelled as a normal task_form_fields row (not a bespoke column) so the upload
-- lands in task_responses like every other task file, which is what makes it
-- appear in the admin Doc column, the deal package, "Download All" and the
-- clerk email with no extra plumbing.
--
-- options.doc_type matters: it is the doc_type the client upload is filed under
-- in lead_corporate_docs, and it is how the clerk email finds the proof when
-- task_responses.file_url is missing (which it often is - see
-- sendDepositProofEmail). accept and max_mb are the portal defaults, written out
-- so changing them later is an edit, not a code change.

INSERT INTO task_form_fields (
  task_template_id, field_type, label, placeholder, required, order_index, options
)
SELECT t.id, 'file', 'Upload Proof of Deposit', NULL, TRUE, 1,
       '{"accept":".pdf,.jpg,.jpeg,.png","max_mb":10,"doc_type":"proof_of_deposit"}'::jsonb
  FROM task_templates t
 WHERE t.is_deleted = false
   AND lower(trim(t.name)) = 'deposit funds into our trust account'
   AND NOT EXISTS (
     SELECT 1 FROM task_form_fields f
      WHERE f.task_template_id = t.id
        AND lower(trim(f.label)) = 'upload proof of deposit'
   );


-- ---------------------------------------------------------------------------
-- 4. Backfill onto existing Purchase files
-- ---------------------------------------------------------------------------
-- Same rules convertLead applies: default templates only, shared tasks live on
-- the PRIMARY deal only (a co-purchaser deal must not get its own copy), and
-- milestone_id is resolved through the deal own milestone for that stage.

INSERT INTO tasks (
  deal_id, title, status, role_type, task_template_id,
  is_shared, activation_required, order_index, milestone_id
)
SELECT
  d.id,
  tt.name,
  'Pending',
  COALESCE(tt.role_type, 'Client'),
  tt.id,
  TRUE,
  TRUE,
  tt.order_index,
  (SELECT m.id FROM milestones m
    WHERE m.deal_id = d.id
      AND m.stage_template_id = tt.stage_template_id
      AND m.is_deleted = false
    LIMIT 1)
FROM deals d
JOIN leads l ON l.id = d.lead_id
CROSS JOIN (
  SELECT id, name, role_type, order_index, stage_template_id
    FROM task_templates
   WHERE is_deleted = false
     AND lower(trim(name)) = 'deposit funds into our trust account'
   LIMIT 1
) tt
WHERE d.is_deleted = false
  AND l.is_deleted = false
  AND l.parent_lead_id IS NULL
  AND d.status <> 'Closed'
  AND COALESCE(d.type, l.lead_type) ILIKE '%Purchase%'
  AND NOT EXISTS (
    SELECT 1 FROM tasks t
     WHERE t.deal_id = d.id
       AND t.task_template_id = tt.id
  );


-- ---------------------------------------------------------------------------
-- 5. Wording
-- ---------------------------------------------------------------------------
-- Both emails are DB-owned so staff can retune them without a deploy; the code
-- carries a fallback so a missing or inactive row never silences the send.

-- 5a. To the CLIENT, when the admin activates the task.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Deposit Funds Task Added',
  'New task added on iClosed - Deposit Funds Into Our Trust Account',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>
    New task &ldquo;Deposit Funds Into Our Trust Account&rdquo; added on iClosed &mdash;
    please log into your iClosed portal to complete the task.
  </p>
  <p style="margin:0 0 4px;"><strong>Balance due on closing:</strong> {{ balance_due }}</p>
  <p style="margin:0 0 4px;"><strong>Property:</strong> {{ property_address }}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> {{ closing_date }}</p>
  <p>
    Your Final Statement of Account is attached, and the funds transfer
    instructions are shown on the task itself.
  </p>
  <p style="margin-top:24px;">
    <a href="{{ portal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open my portal
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">File {{ file_number }}</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Deposit Funds Task Added%'
);

-- 5b. To the CLERKS, when the client uploads their proof of deposit.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Deposit Proof Received',
  'Proof of deposit received - {{ property_street }} (#{{ file_number }}, {{ closing_date }})',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi,</p>
  <p>
    <strong>{{ client_names }}</strong> has uploaded proof of deposit for
    {{ transaction }}. The document is attached.
  </p>
  <p style="margin:0 0 4px;"><strong>Balance due on closing:</strong> {{ balance_due }}</p>
  <p style="margin:0 0 4px;"><strong>Closing date:</strong> {{ closing_date }}</p>
  <p style="margin-top:24px;">
    <a href="{{ deal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open file {{ file_number }}
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">
    File {{ file_number }} &middot; {{ lead_type }} &middot; Closing {{ closing_date }}
  </p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Deposit Proof Received%'
);


-- ---------------------------------------------------------------------------
-- 6. Allow the two new doc_types
-- ---------------------------------------------------------------------------
-- lead_corporate_docs.doc_type carries a CHECK constraint that predates this
-- migrations folder (it was created directly in Supabase), so uploading the
-- statement fails with:
--
--   new row for relation "lead_corporate_docs" violates check constraint
--   "lead_corporate_docs_doc_type_check"
--
-- Two values need adding: 'statement_of_account' (the admin uploads the Final
-- Statement of Account) and 'proof_of_deposit' (the client uploads their proof
-- from the portal). Miss the second and the admin side works while the client
-- hits the same error at the very end of the file.
--
-- Since the constraint's current definition is not in version control, the
-- replacement is built from the values that ACTUALLY EXIST in the table, unioned
-- with the ones the code writes - so the new constraint can never reject a row
-- that is already stored. Same approach as the 2026-08-06 migration.
--
-- Placed last so the section numbers above do not shift for anyone part-way
-- through applying this file; it touches only lead_corporate_docs, so the order
-- relative to sections 1-5 does not matter.

DO $$
DECLARE
  allowed text;
BEGIN
  SELECT string_agg(quote_literal(v), ', ' ORDER BY v)
    INTO allowed
    FROM (
      -- Everything already stored, so no existing row is invalidated.
      SELECT DISTINCT doc_type AS v
        FROM lead_corporate_docs
       WHERE doc_type IS NOT NULL
      UNION
      -- Everything the application writes today.
      SELECT unnest(ARRAY[
        'aps',
        'home_insurance',
        'identification',
        'retainer_agreement',
        'final_report',
        'statement_of_account',
        'proof_of_deposit'
      ])
    ) s;

  ALTER TABLE lead_corporate_docs
    DROP CONSTRAINT IF EXISTS lead_corporate_docs_doc_type_check;

  EXECUTE format(
    'ALTER TABLE lead_corporate_docs ADD CONSTRAINT lead_corporate_docs_doc_type_check '
    'CHECK (doc_type IS NULL OR doc_type IN (%s))',
    allowed
  );
END $$;


-- ---------------------------------------------------------------------------
-- Verification (optional - run separately)
-- ---------------------------------------------------------------------------
-- SELECT id, name, lead_type, is_shared, is_default, activation_required, order_index
--   FROM task_templates WHERE name ILIKE 'Deposit Funds%';
-- SELECT count(*) FROM tasks WHERE title ILIKE 'Deposit Funds%';
-- SELECT name, is_active FROM email_templates WHERE name ILIKE 'Deposit%';
