import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

/**
 * POST /api/admin/backfill-shared-tasks
 *
 * One-time migration: sets `is_shared = true` on all existing tasks
 * whose task_template has `is_shared = true`.
 *
 * This fixes tasks that were created before `is_shared` was being
 * copied from the template during deal conversion.
 */
export async function POST() {
  try {
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
