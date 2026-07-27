-- SEC-006 / SEC-026 / CMP-004 — central audit log for sensitive actions.
--
-- PIPEDA's Accountability principle expects a demonstrable record of who accessed
-- or changed personal information. This table backs recordAudit() in
-- src/lib/recordAudit.ts, which is called from impersonation, destructive
-- deletes, and other sensitive operations.

CREATE TABLE IF NOT EXISTS audit_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action       text NOT NULL,                 -- e.g. 'impersonate', 'deal.delete'
  actor_email  text,                          -- admin who performed the action
  actor_user_id uuid,
  resource_type text,                         -- e.g. 'user', 'deal', 'lead'
  resource_id  text,
  metadata     jsonb,                         -- action-specific extra context
  ip           text,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx
  ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx
  ON audit_logs (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx
  ON audit_logs (actor_email);
