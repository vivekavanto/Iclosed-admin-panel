-- Automatic "complete your tasks" reminder, sent ONCE ~2 days after a client's
-- first login, plus the admin's manual "Remind client" button.
--
--   clients.first_login_at          stamped once by the activate-deal webhook
--                                   (first write wins; never overwritten).
--                                   Left NULL for everyone who logged in before
--                                   this shipped, so the cron never reminds
--                                   historical clients.
--   clients.task_reminder_sent_at   the one-shot. Set by the cron claim or by a
--                                   manual reminder; once set the cron skips the
--                                   client for good.
--
-- No new tables, so no GRANT is needed.

ALTER TABLE clients ADD COLUMN IF NOT EXISTS first_login_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS task_reminder_sent_at timestamptz;

-- The cron's lookup: logged in, not yet reminded.
CREATE INDEX IF NOT EXISTS clients_task_reminder_due_idx
  ON clients (first_login_at)
  WHERE first_login_at IS NOT NULL AND task_reminder_sent_at IS NULL;

-- Wording is DB-owned (editable without a deploy); the code carries a fallback.
-- Placeholders: {{ client_name }}, {{ pending_tasks }} (HTML list, raw),
-- {{ pending_count }}, {{ portal_url }}, {{ file_number }}.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Pending Tasks Reminder',
  'Reminder: please complete your pending tasks on iClosed',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>
    This is a friendly reminder to log into iClosed and complete your pending
    tasks so we can keep your file moving.
  </p>
  {{ pending_tasks }}
  <p style="margin-top:24px;">
    <a href="{{ portal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open my portal
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">File {{ file_number }}</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Pending Tasks Reminder%'
);
