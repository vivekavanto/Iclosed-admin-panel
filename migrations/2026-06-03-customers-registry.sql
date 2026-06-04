-- 2026-06-03-customers-registry.sql
--
-- Purpose: turn public.clients into the CRM-ready CUSTOMER REGISTRY — a single,
-- durable home for each customer's record, separate from authentication, so a
-- future CRM can build on it easily.
--
-- Context: customers are NOT stored only in auth.users. public.clients already
-- holds the customer record (name, email, phone) and links to the login account
-- via auth_user_id; public.leads holds intake detail; public.deals holds files.
-- This migration makes `clients` a clean, dedupe-protected, human-referenceable
-- registry without changing any existing flow.
--
-- IMPORTANT — ADDITIVE only:
--   * Does NOT touch auth.users or login.
--   * The lead→deal conversion already INSERTs into clients; this migration only
--     adds columns/constraints, so that flow keeps working unchanged.

-- 1. Human-readable customer code (CUST-0001, CUST-0002, ...). The UUID `id`
--    stays the technical key + join target (humans never read it); customer_code
--    is the friendly identifier for the UI and a future CRM.
CREATE SEQUENCE IF NOT EXISTS public.clients_code_seq;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS customer_code text,
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

-- Assign a code to every existing customer that doesn't have one yet.
-- Re-run safe: only touches NULLs. Oldest customers get the lowest numbers.
WITH ordered AS (
  SELECT id, row_number() OVER (ORDER BY created_at NULLS LAST, id) AS rn
  FROM public.clients
  WHERE customer_code IS NULL
)
UPDATE public.clients c
SET customer_code = 'CUST-' || lpad(o.rn::text, 4, '0')
FROM ordered o
WHERE c.id = o.id;

-- Move the sequence past the codes we just assigned, so new customers continue
-- the numbering instead of colliding.
SELECT setval(
  'public.clients_code_seq',
  GREATEST((SELECT count(*) FROM public.clients), 1)
);

-- New customers automatically get the next code.
ALTER TABLE public.clients
  ALTER COLUMN customer_code SET DEFAULT 'CUST-' || lpad(nextval('public.clients_code_seq')::text, 4, '0');

ALTER TABLE public.clients
  ALTER COLUMN customer_code SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS clients_customer_code_key
  ON public.clients (customer_code);

-- 2. One customer per email (case-insensitive) — the core guarantee that the
--    same person can't become two customer records going forward.
--    (Verified beforehand that no duplicate emails currently exist.)
CREATE UNIQUE INDEX IF NOT EXISTS clients_email_lower_key
  ON public.clients (lower(email));

-- 3. Keep updated_at fresh on every edit (touches ONLY public.clients).
CREATE OR REPLACE FUNCTION public.clients_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clients_set_updated_at ON public.clients;
CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.clients_set_updated_at();
