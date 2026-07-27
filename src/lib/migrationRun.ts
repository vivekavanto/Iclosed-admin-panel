import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

// GAP-003 — helpers to make one-shot admin backfills refuse to re-run. Backed by
// the migration_runs table (see migrations/2026-07-23-migration-runs.sql).

/** True if a migration with this key has already been recorded as run. */
export async function migrationAlreadyRan(key: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("migration_runs")
    .select("migration_key")
    .eq("migration_key", key)
    .maybeSingle();
  return Boolean(data);
}

/** Record a successful migration run. Best-effort — never throws. */
export async function recordMigrationRun(
  key: string,
  meta?: { ranBy?: string | null; result?: Record<string, unknown> | null },
): Promise<void> {
  try {
    await supabaseAdmin.from("migration_runs").insert({
      migration_key: key,
      ran_by: meta?.ranBy ?? null,
      result: meta?.result ?? null,
    });
  } catch (err) {
    logger.error("[migrationRun] failed to record run:", err);
  }
}
