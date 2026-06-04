-- 2026-06-04-co-client-info-access.sql
--
-- Purpose: store the CONSENT/PERMISSION needed to decide whether the PRIMARY
-- contact may submit identification + personal info ON BEHALF OF a co-seller /
-- co-purchaser. This is the database for the intake "truth table":
--
--   Question asked to the primary at intake:
--     "Would you like to submit identification and personal info on behalf of
--      <Co-Seller / Co-Purchaser name>?"
--   Question asked to each co-client (intake / retainer):
--     "Do you allow the primary contact to submit on your behalf?"
--
--   Truth table (the co-client's answer OVERRIDES the primary's request):
--     | Primary | Co-client | Result                                        |
--     |   Yes   |   Yes     | Primary GETS an auth view to submit for them   |
--     |   Yes   |   No      | No access (separate views, isolated)           |
--     |   No    |   Yes     | No access                                      |
--     |   No    |   No      | No access                                      |
--   Each co-client is judged on its OWN row, so on a Purchase & Sale file the
--   primary can be granted access to CS/CP while CS2/CP2 stays private — handled
--   automatically because every co-client gets its own row here.
--
-- Data model context (already in place — NOT changed by this migration):
--   * Every party is a row in public.leads.
--   * The PRIMARY is the root lead  (parent_lead_id IS NULL).
--   * Each CO-CLIENT is a child lead (parent_lead_id = the primary's id).
--   * The co-client's side (purchase / sale) lives on that child lead, so it is
--     not duplicated here.
--
-- ADDITIVE only: this migration just creates one new table. It does NOT touch
-- leads, deals, clients, or any existing trigger/flow. Safe to re-run.

CREATE TABLE IF NOT EXISTS public.co_client_info_access (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The primary / root lead making (or not making) the request.
  primary_lead_id      uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,

  -- The co-seller / co-purchaser this permission row is about (a child lead).
  co_client_lead_id    uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,

  -- Primary's answer: "I would like to submit on behalf of this co-client."
  primary_requested    boolean NOT NULL DEFAULT false,

  -- Co-client's answer. TRUE = allow, FALSE = deny, NULL = not answered yet.
  -- This value OVERRIDES the primary's request.
  co_consent           boolean,

  -- Effective access = the truth table. Computed by the database, never set by
  -- hand, so it can never disagree with the two answers above. NULL co_consent
  -- (no answer yet) counts as "not allowed".
  access_granted       boolean GENERATED ALWAYS AS
                         (primary_requested AND COALESCE(co_consent, false)) STORED,

  -- When each side answered (optional audit trail).
  primary_requested_at timestamptz,
  co_consent_at        timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  -- One permission row per (primary, co-client) pair.
  CONSTRAINT co_client_info_access_pair_key UNIQUE (primary_lead_id, co_client_lead_id),

  -- A row must be about two different people.
  CONSTRAINT co_client_info_access_distinct_chk CHECK (primary_lead_id <> co_client_lead_id)
);

-- Fast lookups: "what can this primary access?" and "who can act on this
-- co-client?", plus the dashboard "auth view" check (access_granted = true).
CREATE INDEX IF NOT EXISTS co_client_info_access_primary_idx
  ON public.co_client_info_access (primary_lead_id);
CREATE INDEX IF NOT EXISTS co_client_info_access_co_client_idx
  ON public.co_client_info_access (co_client_lead_id);
CREATE INDEX IF NOT EXISTS co_client_info_access_granted_idx
  ON public.co_client_info_access (primary_lead_id) WHERE access_granted;

-- Keep updated_at fresh on every edit (touches ONLY this new table).
CREATE OR REPLACE FUNCTION public.co_client_info_access_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS co_client_info_access_set_updated_at ON public.co_client_info_access;
CREATE TRIGGER co_client_info_access_set_updated_at
  BEFORE UPDATE ON public.co_client_info_access
  FOR EACH ROW
  EXECUTE FUNCTION public.co_client_info_access_set_updated_at();
