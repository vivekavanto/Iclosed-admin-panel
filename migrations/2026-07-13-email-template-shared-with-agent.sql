-- "Shared with agent?" flag on email templates.
--
-- When true, a milestone-completion email built from this template also CCs the
-- deal's referral broker/agent (deals.broker_id -> brokers.email). The client
-- stays the primary recipient; the CC is skipped when the deal has no linked
-- broker or the broker has no email. Surfaced as a checkbox column on the admin
-- Email Templates page.
--
-- Idempotent: safe to re-run.

ALTER TABLE email_templates
  ADD COLUMN IF NOT EXISTS shared_with_agent boolean NOT NULL DEFAULT false;
