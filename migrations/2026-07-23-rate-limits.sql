-- SEC-007 / SEC-011 / SEC-023 — Postgres-backed rate limiting (no Redis needed).
--
-- A fixed-window counter keyed by an arbitrary string (e.g. "reset-pw:email@x.com"
-- or "gemini:<admin-id>"). check_rate_limit() does the increment + window reset
-- atomically in one UPSERT, so concurrent requests across serverless instances
-- can't race past the limit.

CREATE TABLE IF NOT EXISTS rate_limits (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  count        integer NOT NULL DEFAULT 0
);

-- Returns TRUE when the request is ALLOWED (within the limit), FALSE when it
-- should be blocked. Resets the window when it has expired.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int
) RETURNS boolean
LANGUAGE plpgsql
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
