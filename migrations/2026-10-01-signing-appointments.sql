-- Signing Appointment booking system (V1) — fresh design.
--
-- A prior attempt at this feature (signing_appointments, signing_lawyers,
-- signing_lawyer_hours, signing_blocked_times, signing_settings,
-- signing_appointment_events, and an invitation_tokens.type of
-- 'signing_manage') was built and fully reverted earlier today — see
-- migrations/2026-10-01-drop-signing-appointments.sql. Nothing here reuses
-- that schema; this is a ground-up redesign per the client's October 2026
-- requirements doc.
--
-- Scope: replaces the external Calendly / YouCanBook.me booking pages with an
-- in-house system backed by each lawyer's real Google Calendar (via a
-- domain-wide-delegated service account, see src/lib/googleCalendar.ts).
-- Nava Wilson branding only for V1 — no firm_key split on these tables.
--
-- Does NOT reuse invitation_tokens for reschedule/cancel links: that table is
-- consumption-capped and auth-adjacent, which is wrong for a link a client may
-- reopen indefinitely with no auth-session semantics. Instead
-- signing_appointments.manage_token is a single unique column generated at
-- booking time (src/lib/signingAppointmentToken.ts).
--
-- Every new table gets an explicit GRANT ... TO service_role. Tables created
-- via the Supabase SQL editor do NOT automatically inherit it here — see
-- 2026-08-10-client-signup-notifications.sql, which had to repair exactly this
-- for `notifications` / `notification_reads` after it shipped as a silent 500.
-- All access to these tables goes through supabaseAdmin (service-role) only —
-- the public booking routes are unauthenticated by design but still go through
-- the server, never a browser-side anon/authenticated Supabase client.
--
-- Idempotent: safe to re-run.

BEGIN;

-- 1 ─── signing_lawyers ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signing_lawyers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  initials     text NOT NULL UNIQUE,            -- 'AT', 'GM'
  full_name    text NOT NULL,
  email        text NOT NULL,                   -- Workspace email the service account impersonates
  calendar_id  text NOT NULL DEFAULT 'primary',
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signing_lawyers TO service_role;

-- 2 ─── signing_lawyer_hours ──────────────────────────────────────────────────
-- Weekly recurring availability template. One row per (lawyer, day).
CREATE TABLE IF NOT EXISTS signing_lawyer_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id   uuid NOT NULL REFERENCES signing_lawyers(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun..6=Sat
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lawyer_id, day_of_week)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signing_lawyer_hours TO service_role;

-- 3 ─── signing_blocked_times ─────────────────────────────────────────────────
-- Manual admin blocks (vacation, closures). lawyer_id NULL = blocks everyone.
CREATE TABLE IF NOT EXISTS signing_blocked_times (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id   uuid REFERENCES signing_lawyers(id) ON DELETE CASCADE,
  start_at    timestamptz NOT NULL,
  end_at      timestamptz NOT NULL,
  reason      text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signing_blocked_times TO service_role;

-- 4 ─── signing_settings ──────────────────────────────────────────────────────
-- Single-row config table, same "one active row, upsert fixed id" convention
-- as closing_cost_shared_rates (see src/lib/closingCostConfig.ts).
CREATE TABLE IF NOT EXISTS signing_settings (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  default_duration_minutes  integer NOT NULL DEFAULT 30,
  buffer_minutes            integer NOT NULL DEFAULT 15,
  slot_increment_minutes    integer NOT NULL DEFAULT 15,
  office_address            text NOT NULL DEFAULT '10 Milner Business Court Scarborough, ON M1B 3C6',
  clerk_email               text NOT NULL DEFAULT 'Marcela@navawilson.law',
  reception_email           text NOT NULL DEFAULT 'reception@navawilson.law',
  disclaimer_text           text NOT NULL DEFAULT 'Please schedule your signing appointment 1-3 business days before your closing date. Note: Appointments are subject to our office receiving the required mortgage instructions (for purchases) and payout statement (for sales). If the required documents are not received in time, your appointment may need to be rescheduled.',
  updated_at                timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signing_settings TO service_role;

-- Seed the single settings row if the table is empty.
INSERT INTO signing_settings (id)
SELECT gen_random_uuid()
WHERE NOT EXISTS (SELECT 1 FROM signing_settings);

-- 5 ─── signing_appointments ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signing_appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lawyer_id           uuid NOT NULL REFERENCES signing_lawyers(id),
  status              text NOT NULL DEFAULT 'confirmed'
                         CHECK (status IN ('confirmed', 'cancelled')),
  start_at            timestamptz NOT NULL,
  end_at              timestamptz NOT NULL,
  appointment_type    text NOT NULL CHECK (appointment_type IN ('virtual', 'in_person')),
  deal_type           text CHECK (deal_type IN ('purchase', 'sale')),
  client_name         text NOT NULL,
  client_email        text NOT NULL,
  client_phone        text,
  property_address    text,
  closing_date        date,
  file_number         text,
  extra_guests        text[] NOT NULL DEFAULT '{}',
  extra_cohosts       text[] NOT NULL DEFAULT '{}',
  google_event_id     text,
  google_meet_link    text,
  lead_id             uuid REFERENCES leads(id),   -- nullable in V1; populated in V2
  deal_id             uuid REFERENCES deals(id),   -- nullable in V1; populated in V2
  manage_token        text UNIQUE,
  created_by          uuid,                        -- admin_users id when staff-created; null for client self-service
  rescheduled_at       timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signing_appointments_lawyer_window_idx
  ON signing_appointments (lawyer_id, start_at)
  WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS signing_appointments_manage_token_idx
  ON signing_appointments (manage_token);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.signing_appointments TO service_role;

COMMIT;

-- Verification. service_role grants MUST all read true.
SELECT
  has_table_privilege('service_role', 'public.signing_lawyers', 'SELECT')        AS lawyers_grant_ok,
  has_table_privilege('service_role', 'public.signing_lawyer_hours', 'SELECT')   AS hours_grant_ok,
  has_table_privilege('service_role', 'public.signing_blocked_times', 'SELECT') AS blocked_grant_ok,
  has_table_privilege('service_role', 'public.signing_settings', 'SELECT')      AS settings_grant_ok,
  has_table_privilege('service_role', 'public.signing_appointments', 'SELECT') AS appointments_grant_ok,
  (SELECT count(*) FROM signing_settings) AS settings_rows;
