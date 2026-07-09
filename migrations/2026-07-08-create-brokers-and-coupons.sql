-- Referral-source master data: Coupons + Brokers.
--
-- A **coupon** is a shared discount code (percent | fixed). A **broker** is a
-- referral source (mortgage broker / real-estate agent) that may be mapped to
-- at most one coupon, while a single coupon can be shared by many brokers
-- (one coupon → many brokers). So the FK lives on `brokers.coupon_id`.
--
-- Coupons is created FIRST so brokers can reference it. Both carry a soft-delete
-- flag (`is_deleted`) and timestamptz audit columns, matching repo conventions.
--
-- Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- coupons — shared discount master
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coupons (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL,
  discount_type  TEXT CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  is_deleted     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One live coupon per code (case-insensitive). Soft-deleted rows are excluded
-- so a code can be reused after its coupon is deleted.
CREATE UNIQUE INDEX IF NOT EXISTS coupons_code_unique_idx
  ON coupons (lower(code))
  WHERE is_deleted = false;

-- ─────────────────────────────────────────────────────────────────────
-- brokers — referral source master (points at its shared coupon)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS brokers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT,
  phone       TEXT,
  type        TEXT CHECK (type IN ('Mortgage Broker', 'Real Estate Agent')),
  company     TEXT,
  coupon_id   UUID REFERENCES coupons(id) ON DELETE SET NULL,
  is_deleted  BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brokers_coupon_id_idx ON brokers (coupon_id);

-- ─────────────────────────────────────────────────────────────────────
-- Grants + RLS
-- ─────────────────────────────────────────────────────────────────────
-- Supabase's default privileges did NOT reach these freshly-created tables, so
-- even the service_role client hit "permission denied for table". Grant table
-- privileges explicitly (mirrors 2026-06-03-fix-trigger-sequence-permission.sql).
GRANT ALL ON coupons TO anon, authenticated, service_role;
GRANT ALL ON brokers TO anon, authenticated, service_role;

-- These are admin-managed masters. Enable RLS with NO policies so the anon /
-- authenticated grants above can't read or write them through the public key;
-- the admin API uses the service_role key, which BYPASSES RLS and keeps working.
ALTER TABLE coupons ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokers ENABLE ROW LEVEL SECURITY;
