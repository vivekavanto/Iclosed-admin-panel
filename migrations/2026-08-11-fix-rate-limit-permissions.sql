-- Fix: check_rate_limit() has never actually rate-limited anything.
--
-- ── The bug ─────────────────────────────────────────────────────────────────
-- 2026-07-23-rate-limits.sql created `rate_limits` and `check_rate_limit()` but
-- issued no GRANT, and Supabase's default privileges do not reach freshly
-- created tables (the same trap 2026-07-08-create-brokers-and-coupons.sql
-- documents). The function is not SECURITY DEFINER either, so it executes with
-- the CALLER's privileges — service_role, which had none on the table.
--
-- Every call therefore returned:
--     42501: permission denied for table rate_limits
--
-- and `rateLimitOk` (src/lib/rateLimit.ts) deliberately FAILS OPEN on error, so
-- the request was allowed. Silently. Every limit in the app — password reset,
-- Gemini document classification, the closing-estimate PDF route, and the public
-- /api/calculator/* endpoints — has been a no-op since it was introduced.
--
-- Nothing in the app logs loudly enough to have caught this: fail-open is the
-- right behaviour for an infra hiccup, but it makes a PERMANENT misconfiguration
-- indistinguishable from "no one is hitting the limit".
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Both halves, deliberately:
--
--   1. SECURITY DEFINER so the function runs as its owner and works no matter
--      which role calls it. `search_path` is pinned because a SECURITY DEFINER
--      function with a caller-controlled search_path is a privilege-escalation
--      hole — an attacker who can create `pg_temp.rate_limits` would otherwise
--      have the definer write there instead.
--   2. The explicit table GRANT as well, so the counter still works if the
--      function is ever recreated without SECURITY DEFINER.
--
-- Verify after applying (run twice — the second call must return false):
--   SELECT check_rate_limit('verify:probe', 1, 60);

-- ─────────────────────────────────────────────────────────────────────
-- Table privileges. Mirrors 2026-07-08-create-brokers-and-coupons.sql.
GRANT ALL ON rate_limits TO anon, authenticated, service_role;

-- RLS ON with NO policies, so the anon / authenticated grants above cannot be
-- used to read or tamper with the counters through the public key. The server
-- reaches this table only via the service_role client, which BYPASSES RLS, and
-- via the SECURITY DEFINER function below.
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────
-- Re-declare the function as SECURITY DEFINER. The body is unchanged from
-- 2026-07-23-rate-limits.sql — a fixed-window counter incremented atomically in
-- one UPSERT, so concurrent requests across serverless instances cannot race
-- past the limit.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now   timestamptz := now();
  v_count int;
BEGIN
  INSERT INTO rate_limits (key, window_start, count)
    VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
    SET
      count = CASE
        WHEN rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
        THEN 1
        ELSE rate_limits.count + 1
      END,
      window_start = CASE
        WHEN rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
        THEN v_now
        ELSE rate_limits.window_start
      END
  RETURNING count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION check_rate_limit(text, int, int)
  TO anon, authenticated, service_role;
