import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { migrationAlreadyRan, recordMigrationRun } from "@/lib/migrationRun";
import { getActingAdmin } from "@/lib/getActingAdmin";

const MIGRATION_KEY = "backfill-shared-tasks";

/**
 * POST /api/admin/backfill-shared-tasks
 *
 * One-time migration: sets `is_shared = true` on all existing tasks
 * whose task_template has `is_shared = true`.
 *
 * This fixes tasks that were created before `is_shared` was being
 * copied from the template during deal conversion.
 *
 * GAP-003: idempotency-guarded — once it has run successfully it refuses to run
 * again (returns alreadyRan) unless the body carries { force: true }.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const force = body?.force === true;

    if (!force && (await migrationAlreadyRan(MIGRATION_KEY))) {
      return NextResponse.json({
        success: true,
        alreadyRan: true,
        message:
          "backfill-shared-tasks has already been run. Pass { force: true } to run it again.",
        updated: 0,
      });
    }

    // Step 1: Find all task_templates that are shared
    const { data: sharedTemplates, error: tplError } = await supabaseAdmin
      .from("task_templates")
      .select("id, name")
      .eq("is_shared", true);

    if (tplError) {
      return NextResponse.json({ success: false, error: tplError.message }, { status: 500 });
    }

    if (!sharedTemplates || sharedTemplates.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No shared task templates found. Make sure task_templates have is_shared = true for: Upload APS, Home Insurance, Status of Mortgage, Schedule Appointment.",
        updated: 0,
      });
    }

    const sharedTemplateIds = sharedTemplates.map((t) => t.id);

    // Step 2: Update all tasks that reference these templates but don't have is_shared set
    const { data: updated, error: updateError } = await supabaseAdmin
      .from("tasks")
      .update({ is_shared: true })
      .in("task_template_id", sharedTemplateIds)
      .or("is_shared.is.null,is_shared.eq.false")
      .select("id");

    if (updateError) {
      return NextResponse.json({ success: false, error: updateError.message }, { status: 500 });
    }

    // GAP-003: record the run so a later invocation is refused (unless forced).
    const actor = await getActingAdmin();
    await recordMigrationRun(MIGRATION_KEY, {
      ranBy: actor.email,
      result: { updated: updated?.length ?? 0 },
    });

    return NextResponse.json({
      success: true,
      message: `Backfilled ${updated?.length ?? 0} tasks with is_shared = true`,
      updated: updated?.length ?? 0,
      shared_templates: sharedTemplates.map((t) => t.name),
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
