-- Agent portal: which task completions an agent wants to be notified about.
-- One row per partner; the setting applies to every file they referred.
-- task_template_ids lists the opted-in task templates (empty = none).

CREATE TABLE IF NOT EXISTS partner_notification_settings (
  partner_id        uuid PRIMARY KEY REFERENCES partners(id) ON DELETE CASCADE,
  task_template_ids uuid[] NOT NULL DEFAULT '{}',
  updated_by        text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE partner_notification_settings ENABLE ROW LEVEL SECURITY;
GRANT ALL ON partner_notification_settings TO service_role;
