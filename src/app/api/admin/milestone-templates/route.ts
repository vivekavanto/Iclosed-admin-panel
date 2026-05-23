import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET() {
  const { data, error } = await supabase
    .from("stage_templates")
    .select("*, email_templates(id, name)")
    .order("order_index", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, lead_type, order_index, role, is_shared, email_template_id, auto_complete } = body;

  if (!name || !lead_type) {
    return NextResponse.json({ error: "Name and lead type are required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("stage_templates")
    .insert([{
      name,
      description: description ?? null,
      lead_type,
      order_index: order_index ?? 0,
      role: role ?? "Client",
      is_shared: is_shared ?? false,
      email_template_id: email_template_id || null,
      auto_complete: auto_complete ?? false,
    }])
    .select("*, email_templates(id, name)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const { id, name, description, lead_type, order_index, role, is_shared, email_template_id, auto_complete } = body;

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("stage_templates")
    .update({
      name,
      description: description ?? null,
      lead_type,
      order_index: order_index ?? 0,
      role: role ?? "Client",
      is_shared: is_shared ?? false,
      email_template_id: email_template_id || null,
      auto_complete: auto_complete ?? false,
    })
    .eq("id", id)
    .select("*, email_templates(id, name)")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const preview = searchParams.get("preview") === "1";

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  // Preview mode: count what would be wiped without deleting anything, so
  // the confirm dialog on the UI can spell out exactly what's about to go.
  if (preview) {
    const { data: msRows, error: msErr } = await supabase
      .from("milestones")
      .select("id")
      .eq("stage_template_id", id);
    if (msErr) return NextResponse.json({ error: msErr.message }, { status: 500 });
    const msIds = (msRows ?? []).map((m) => m.id);

    let taskCount = 0;
    let respCount = 0;
    if (msIds.length > 0) {
      const { count: tc } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .in("milestone_id", msIds);
      taskCount = tc ?? 0;

      const { data: taskRows } = await supabase
        .from("tasks")
        .select("id")
        .in("milestone_id", msIds);
      const taskIds = (taskRows ?? []).map((t) => t.id);
      if (taskIds.length > 0) {
        const { count: rc } = await supabase
          .from("task_responses")
          .select("id", { count: "exact", head: true })
          .in("task_id", taskIds);
        respCount = rc ?? 0;
      }
    }

    return NextResponse.json({
      preview: true,
      milestones: msIds.length,
      tasks: taskCount,
      task_responses: respCount,
    });
  }

  // Hard cascade: wipe every deal-side row that points at this stage
  // template before deleting the template itself. Order matters because of
  // foreign keys — drill down to the leaves first.

  // 1. Find every milestone that uses this template (across all deals).
  const { data: milestoneRows, error: msFetchErr } = await supabase
    .from("milestones")
    .select("id")
    .eq("stage_template_id", id);
  if (msFetchErr) {
    return NextResponse.json({ error: msFetchErr.message }, { status: 500 });
  }
  const milestoneIds = (milestoneRows ?? []).map((m) => m.id);

  let deletedTasks = 0;
  let deletedResponses = 0;
  if (milestoneIds.length > 0) {
    // 2. Find every task attached to those milestones.
    const { data: taskRows, error: taskFetchErr } = await supabase
      .from("tasks")
      .select("id")
      .in("milestone_id", milestoneIds);
    if (taskFetchErr) {
      return NextResponse.json({ error: taskFetchErr.message }, { status: 500 });
    }
    const taskIds = (taskRows ?? []).map((t) => t.id);

    // 3. Delete task_responses for those tasks.
    if (taskIds.length > 0) {
      const { error: respErr, count: respCount } = await supabase
        .from("task_responses")
        .delete({ count: "exact" })
        .in("task_id", taskIds);
      if (respErr) {
        return NextResponse.json({ error: respErr.message }, { status: 500 });
      }
      deletedResponses = respCount ?? 0;

      // 4. Delete the tasks themselves.
      const { error: tasksErr, count: tasksCount } = await supabase
        .from("tasks")
        .delete({ count: "exact" })
        .in("id", taskIds);
      if (tasksErr) {
        return NextResponse.json({ error: tasksErr.message }, { status: 500 });
      }
      deletedTasks = tasksCount ?? 0;
    }

    // 5. Delete the milestones.
    const { error: msDelErr } = await supabase
      .from("milestones")
      .delete()
      .in("id", milestoneIds);
    if (msDelErr) {
      return NextResponse.json({ error: msDelErr.message }, { status: 500 });
    }
  }

  // 6. Detach any task_templates that pointed at this stage template so the
  //    stage template FK no longer blocks the delete. Task templates are
  //    admin-level config (not deal data) — keep them around, just null out
  //    the back-link.
  const { error: ttDetachErr } = await supabase
    .from("task_templates")
    .update({ stage_template_id: null })
    .eq("stage_template_id", id);
  if (ttDetachErr) {
    return NextResponse.json({ error: ttDetachErr.message }, { status: 500 });
  }

  // 7. Finally, delete the stage template.
  const { error } = await supabase
    .from("stage_templates")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    deleted_milestones: milestoneIds.length,
    deleted_tasks: deletedTasks,
    deleted_task_responses: deletedResponses,
  });
}
