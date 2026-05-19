-- Custom-issued tokens for the "Activate your account" / "Reset Password"
-- emails. Replaces sole reliance on Supabase's built-in generateLink expiry
-- (default 24h) with a code-owned 7-day window. The admin app mints these
-- tokens at send time and validates them when the recipient clicks the
-- email button. On valid click, the route handler exchanges the token for
-- a fresh Supabase action_link and 302-redirects, so the customer-portal
-- /api/auth/callback?next=/set-password flow runs unchanged.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS invitation_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT NOT NULL UNIQUE,
  email        TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('invite', 'recovery')),
  redirect_to  TEXT NOT NULL,
  user_data    JSONB,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invitation_tokens_token_idx ON invitation_tokens(token);
CREATE INDEX IF NOT EXISTS invitation_tokens_email_idx ON invitation_tokens(email);
