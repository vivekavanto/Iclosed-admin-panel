-- Automatic "Your Closing Day Update" email, sent at 9AM (Toronto) on the
-- morning a file closes, to each client on the file.
--
--   deals.closing_day_email_sent_on   the closing DATE the email was sent for.
--                                     The cron claims it (conditional UPDATE)
--                                     before sending, so overlapping runs cannot
--                                     double-send. Storing the date rather than a
--                                     flag lets a Purchase & Sale file (two
--                                     closing dates on one deal) get a second
--                                     email if the sale closes on another day.
--
-- No new tables, so no GRANT is needed.

ALTER TABLE deals ADD COLUMN IF NOT EXISTS closing_day_email_sent_on date;

-- Wording is DB-owned (editable without a deploy); the code carries a fallback.
-- Placeholders: {{ client_name }}, {{ file_number }}.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Closing Day Update',
  'Your Closing Day Update',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Good morning {{ client_name }},</p>
  <p>
    Today is your closing day! Our team is working through the final steps to
    complete your transaction. There’s nothing further you need to do at this
    stage. If we need anything from you, we’ll reach out directly.
  </p>
  <p>We’ll keep you updated and let you know as soon as your closing is complete.</p>
  <p>Best regards,</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Closing Day Update%'
);
