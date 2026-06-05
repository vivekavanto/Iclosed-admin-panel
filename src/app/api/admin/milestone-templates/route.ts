import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET() {
  const { data, error } = await supabase
    .from("stage_templates")
    .select("*, email_templates(id, name)")
    .eq("is_deleted", false)
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

  // Capture the previous name BEFORE updating so we can propagate a rename to
  // the snapshot copies already created on deals. milestones.title (and its
  // description / email_template_id) are copied from the stage_template at
  // lead-conversion time (see convertLead.ts) and are never re-synced on their
  // own — the customer portal reads milestones.title directly.
  const { data: prevTemplate } = await supabase
    .from("stage_templates")
    .select("name")
    .eq("id", id)
    .maybeSingle();
  const previousName: string | null = prevTemplate?.name ?? null;

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

  // Propagate the edit to every already-created milestone that still carries
  // the OLD template name. Guarding by `title = previousName` preserves any
  // per-deal manual milestone-title edits while keeping standard milestones in
  // sync (name, description, and email template). This is what makes a stage
  // rename reflect in the customer portal. Non-blocking: a failed propagation
  // must not fail the template update itself.
  if (name && previousName) {
    try {
      await supabase
        .from("milestones")
        .update({
          title: name,
          description: description ?? null,
          email_template_id: email_template_id || null,
        })
        .eq("stage_template_id", id)
        .eq("title", previousName)
        .eq("is_deleted", false);
    } catch (propErr) {
      console.error("[StageTemplate PUT] Milestone propagation failed (non-blocking):", propErr);
    }
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
      .eq("stage_template_id", id)
      .eq("is_deleted", false);
    if (msErr) return NextResponse.json({ error: msErr.message }, { status: 500 });
    const msIds = (msRows ?? []).map((m) => m.id);

    let taskCount = 0;
    let respCount = 0;
    if (msIds.length > 0) {
      const { count: tc } = await supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .in("milestone_id", msIds)
        .eq("is_deleted", false);
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

  // Soft cascade: flag every deal-side row that points at this stage template
  // as is_deleted, then flag the template itself. We KEEP task_responses and
  // leave the task_templates back-link intact, so the whole cascade is
  // reversible by flipping is_deleted back to false on the template + its rows.

  // 1. Find every (still-active) milestone that uses this template.
  const { data: milestoneRows, error: msFetchErr } = await supabase
    .from("milestones")
    .select("id")
    .eq("stage_template_id", id)
    .eq("is_deleted", false);
  if (msFetchErr) {
    return NextResponse.json({ error: msFetchErr.message }, { status: 500 });
  }
  const milestoneIds = (milestoneRows ?? []).map((m) => m.id);

  let deletedTasks = 0;
  if (milestoneIds.length > 0) {
    // 2. Find every active task attached to those milestones.
    const { data: taskRows, error: taskFetchErr } = await supabase
      .from("tasks")
      .select("id")
      .in("milestone_id", milestoneIds)
      .eq("is_deleted", false);
    if (taskFetchErr) {
      return NextResponse.json({ error: taskFetchErr.message }, { status: 500 });
    }
    const taskIds = (taskRows ?? []).map((t) => t.id);

    // 3. Soft-delete the tasks (task_responses are intentionally kept intact).
    if (taskIds.length > 0) {
      const { error: tasksErr, count: tasksCount } = await supabase
        .from("tasks")
        .update({ is_deleted: true }, { count: "exact" })
        .in("id", taskIds);
      if (tasksErr) {
        return NextResponse.json({ error: tasksErr.message }, { status: 500 });
      }
      deletedTasks = tasksCount ?? 0;
    }

    // 4. Soft-delete the milestones.
    const { error: msDelErr } = await supabase
      .from("milestones")
      .update({ is_deleted: true })
      .in("id", milestoneIds);
    if (msDelErr) {
      return NextResponse.json({ error: msDelErr.message }, { status: 500 });
    }
  }

  // 5. Soft-delete the stage template itself. The task_templates back-link is
  //    left intact (the template row still exists), so a restore is clean.
  const { error } = await supabase
    .from("stage_templates")
    .update({ is_deleted: true })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    deleted_milestones: milestoneIds.length,
    deleted_tasks: deletedTasks,
  });
}
