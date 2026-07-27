-- GAP-003 — record one-time backfill/migration runs so they aren't re-executed.
--
-- Backing table for src/lib/migrationRun.ts. Each one-shot admin backfill records
-- its key here on success; the route refuses to re-run (unless forced) once a key
-- is present, so a second invocation can't redo a heavy rewrite.

CREATE TABLE IF NOT EXISTS migration_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  migration_key text NOT NULL UNIQUE,
  ran_by        text,
  result        jsonb,
  ran_at        timestamptz NOT NULL DEFAULT now()
);
