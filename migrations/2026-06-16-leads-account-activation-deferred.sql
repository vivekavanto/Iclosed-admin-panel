-- Track parties who signed the retainer but chose "I'll do this later" instead
-- of activating their account on the spot.
--
-- In the new retainer flow the party signs first (no account), then sees an
-- "Activate your account" / "I'll do this later" prompt. Choosing "later" sets
-- this flag so the admin (and any reminder job) can target exactly the people
-- who have a signature on file but no portal account yet — i.e. send them the
-- existing "Activate Account" email as a REMINDER rather than blasting everyone.
--
-- The flag is set true by the retainer-signed webhook when the portal reports
-- the "later" choice, and is irrelevant once clients.auth_user_id is populated
-- (account activated). Defaults to false so existing rows are unaffected.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS account_activation_deferred boolean NOT NULL DEFAULT false;
