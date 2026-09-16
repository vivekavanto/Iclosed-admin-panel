import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

/**
 * GET /api/admin/task-form-fields?task_template_id=...
 *
 * Returns the form-field definitions for a task template (label, type,
 * placeholder, required, options, order). Used by the admin Edit Task
 * modal so it can render every field the client-facing form shows —
 * filled or empty — letting admins complete or correct submissions on
 * behalf of the user.
 *
 * `note` fields are excluded — they collect no answer, so on the admin side
 * they would render as stray empty inputs.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const taskTemplateId = searchParams.get("task_template_id");

  if (!taskTemplateId) {
    return NextResponse.json(
      { error: "task_template_id is required" },
      { status: 400 },
    );
  }

  const { data, error } = await supabaseAdmin
    .from("task_form_fields")
    // "*" so visible_when is picked up once migrated without breaking before.
    .select("*")
    .eq("task_template_id", taskTemplateId)
    .neq("field_type", "note")
    .order("order_index", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}
