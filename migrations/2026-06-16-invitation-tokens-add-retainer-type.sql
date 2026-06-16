-- Allow a third invitation_tokens.type: 'retainer_sign'.
--
-- The retainer "sign without an account" flow reuses the existing
-- invitation_tokens machinery (createInvitationToken / consumeInvitationToken)
-- so it inherits the same 7-day, scanner-safe wrapper-token semantics as the
-- invite/recovery links. A retainer-sign token carries its scope in the
-- existing columns — redirect_to (the portal signing page) and user_data
-- (jsonb: { lead_id, side, primary_lead_id, kind:'retainer_sign' }) — so no
-- new columns are required, only a relaxed CHECK.
--
-- The original constraint was created inline in 2026-05-19-create-invitation-
-- tokens.sql, so Postgres named it invitation_tokens_type_check. We drop it by
-- that conventional name and re-add the widened version.
--
-- Idempotent: drop-if-exists then add re-creates the same named constraint on
-- every run.

ALTER TABLE invitation_tokens
  DROP CONSTRAINT IF EXISTS invitation_tokens_type_check;

ALTER TABLE invitation_tokens
  ADD CONSTRAINT invitation_tokens_type_check
  CHECK (type IN ('invite', 'recovery', 'retainer_sign'));
