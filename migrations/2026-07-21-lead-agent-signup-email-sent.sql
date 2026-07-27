-- Idempotency guard for the "Signup email to agents" notification.
--
-- When a client ACTIVATES their account (sets a password / first login — the
-- point at which their deal is promoted off "Inactive"), /api/webhooks/new-lead
-- fires the client welcome email AND — separately — a one-off notification
-- addressed TO the client's referral agent/broker ("Your client just signed up
-- on iClosed"). The agent recipient is resolved from leads.partner_id ->
-- partners.agent_email, falling back to the free-text leads.referral_agent_email
-- when the client named an off-system agent instead of applying a code.
--
-- This column is the per-lead "already notified the agent" flag, mirroring
-- leads.welcome_email_sent. The webhook can be retried safely and the portal may
-- call it on every login, so without this guard the agent would be emailed
-- repeatedly.
--
-- Idempotent: safe to re-run.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS agent_signup_email_sent boolean NOT NULL DEFAULT false;
