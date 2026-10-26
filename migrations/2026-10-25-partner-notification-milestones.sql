-- Agent portal notifications are chosen per milestone, not per task.
-- The table had no rows when this was written, so a rename is enough.
ALTER TABLE partner_notification_settings RENAME COLUMN task_template_ids TO stage_template_ids;
