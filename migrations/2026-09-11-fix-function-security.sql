-- 2026-09-11-fix-function-security.sql
--
-- Purpose: Fix Supabase linter warnings related to function security:
-- - 0011_function_search_path_mutable: Functions without pinned search_path
-- - 0028/0029: SECURITY DEFINER functions callable by anon/authenticated
--
-- Strategy:
-- 1. Ensure all SECURITY DEFINER functions have `SET search_path` pinned
-- 2. Convert internal trigger functions to SECURITY INVOKER (removes warning)
-- 3. Keep public-callable functions as SECURITY DEFINER with search_path

-- ════════════════════════════════════════════════════════════════════════════
-- 1. UPDATED_AT TRIGGERS — add missing SET search_path (0011 warnings)
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.users_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.clients_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. INTERNAL TRIGGER FUNCTIONS — keep SECURITY DEFINER but revoke RPC access
--    These functions need elevated privileges to insert/update clients and work
--    with sequences. Trigger invocation still works (database calls them directly).
--    Revoking EXECUTE prevents direct RPC calls from anon/authenticated users.
-- ════════════════════════════════════════════════════════════════════════════

-- Ensure functions have SET search_path (if they don't already from prior migrations)
-- Note: These functions may have already been updated in earlier migrations with
-- proper SECURITY DEFINER + SET search_path. This is idempotent re-declaration.

CREATE OR REPLACE FUNCTION public.sync_lead_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  -- Staff/admin emails belong in admin_users, not clients.
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.clients (email, first_name, last_name, phone, converted)
  VALUES (NEW.email, NEW.first_name, NEW.last_name, NEW.phone, false)
  ON CONFLICT (lower(email)) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_client_converted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'Converted'
     AND COALESCE(OLD.status, '') <> 'Converted'
     AND NEW.email IS NOT NULL THEN
    UPDATE public.clients SET converted = true
    WHERE lower(email) = lower(NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_lead_phone_across_person()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act when phone actually changed and we have an email to key on.
  IF NEW.phone IS NOT DISTINCT FROM OLD.phone THEN RETURN NEW; END IF;
  IF NEW.email IS NULL OR btrim(NEW.email) = '' THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.admin_users a WHERE lower(a.email) = lower(NEW.email)) THEN
    RETURN NEW;
  END IF;

  -- Propagate to the person's OTHER leads.
  UPDATE public.leads
  SET phone = NEW.phone
  WHERE lower(email) = lower(NEW.email)
    AND id <> NEW.id
    AND phone IS DISTINCT FROM NEW.phone;

  -- Keep the single customer record in sync too.
  UPDATE public.clients
  SET phone = NEW.phone
  WHERE lower(email) = lower(NEW.email)
    AND phone IS DISTINCT FROM NEW.phone;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_personal_info_to_clients()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title     text;
  v_deal_id   uuid;
  v_client_id uuid;
  v_label     text;
  v_value     text;
  v_col       text;
BEGIN
  IF NEW.task_id IS NULL OR NEW.field_label IS NULL THEN
    RETURN NEW;
  END IF;

  -- Only sync for Personal Information tasks.
  SELECT t.title, t.deal_id INTO v_title, v_deal_id
  FROM public.tasks t WHERE t.id = NEW.task_id;

  IF v_title IS NULL OR lower(v_title) NOT LIKE '%personal info%' THEN
    RETURN NEW;
  END IF;

  -- Resolve the customer this task belongs to.
  SELECT d.client_id INTO v_client_id
  FROM public.deals d WHERE d.id = v_deal_id;

  IF v_client_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Never overwrite a client field with an empty value (protects drafts).
  v_value := NULLIF(btrim(COALESCE(NEW.value, '')), '');
  IF v_value IS NULL THEN
    RETURN NEW;
  END IF;

  -- Map the response's field label to a clients column.
  v_label := lower(btrim(NEW.field_label));
  IF    v_label LIKE '%street%'                                          THEN v_col := 'address_street';
  ELSIF v_label = 'city' OR v_label LIKE 'city%'                         THEN v_col := 'address_city';
  ELSIF v_label LIKE '%postal%'                                          THEN v_col := 'address_postal_code';
  ELSIF v_label LIKE '%marital%'                                         THEN v_col := 'marital_status';
  ELSIF v_label LIKE '%citizenship%'                                     THEN v_col := 'citizenship_status';
  ELSIF v_label LIKE '%occupation%'                                      THEN v_col := 'occupation';
  ELSIF (v_label LIKE '%employer%' OR v_label LIKE '%business%')
        AND v_label LIKE '%phone%'                                       THEN v_col := 'employer_phone';
  ELSIF v_label LIKE '%phone%'                                           THEN v_col := 'phone';
  ELSE
    RETURN NEW;  -- field has no matching clients column
  END IF;

  -- Update only the one mapped column. v_col is from a fixed allowlist above,
  -- so the dynamic SQL is safe.
  EXECUTE format('UPDATE public.clients SET %I = $1 WHERE id = $2', v_col)
  USING v_value, v_client_id;

  RETURN NEW;
END;
$$;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. REVOKE RPC-LEVEL ACCESS to internal trigger functions
--    These functions keep SECURITY DEFINER (for elevated privileges needed by
--    their logic), but are revoked from anon/authenticated so they cannot be
--    called directly via PostgREST RPC. Trigger invocations still work (bypass
--    permission checks when invoked by the database).
-- ════════════════════════════════════════════════════════════════════════════

REVOKE EXECUTE ON FUNCTION public.sync_lead_to_clients() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_client_converted() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_lead_phone_across_person() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_personal_info_to_clients() FROM anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. PUBLIC-CALLABLE FUNCTIONS — keep SECURITY DEFINER with pinned search_path
--    These need elevated privileges to work correctly.
-- ════════════════════════════════════════════════════════════════════════════

-- Already fixed in 2026-05-26-fix-deal-activation-linkage.sql and
-- 2026-08-11-fix-rate-limit-permissions.sql (both have SET search_path).
-- No changes needed here.
