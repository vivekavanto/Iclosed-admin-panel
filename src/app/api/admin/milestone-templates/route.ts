import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { backfillMilestoneForStage } from "@/lib/reconcileDealMilestoneLinks";

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

  // Seed this brand-new milestone onto every existing deal of its lead_type so
  // it shows up on already-active customer dashboards, not just future deals.
  // Non-blocking — the template was created successfully regardless.
  let backfilledMilestones = 0;
  try {
    const res = await backfillMilestoneForStage(data.id);
    backfilledMilestones = res.created;
  } catch (backfillErr) {
    console.error("[StageTemplate POST] Milestone backfill failed (non-blocking):", backfillErr);
  }

  return NextResponse.json({ ...data, backfilledMilestones }, { status: 201 });
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
    .select("name, auto_complete")
    .eq("id", id)
    .maybeSingle();
  const previousName: string | null = prevTemplate?.name ?? null;
  const previousAutoComplete: boolean = prevTemplate?.auto_complete ?? false;

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
          order_index: order_index ?? 0,
        })
        .eq("stage_template_id", id)
        .eq("title", previousName)
        .eq("is_deleted", false);
    } catch (propErr) {
      console.error("[StageTemplate PUT] Milestone propagation failed (non-blocking):", propErr);
    }
  }

  // Backfill any deals of this lead_type that are missing the milestone
  // entirely (e.g. deals converted before this stage existed, or whose
  // lead_type just changed to match). Non-blocking.
  let backfilledMilestones = 0;
  try {
    const res = await backfillMilestoneForStage(id);
    backfilledMilestones = res.created;
  } catch (backfillErr) {
    console.error("[StageTemplate PUT] Milestone backfill failed (non-blocking):", backfillErr);
  }

  // Auto-complete cascade: when an admin turns ON `auto_complete` for a stage
  // that wasn't auto-completing before, retroactively complete that milestone
  // on every existing deal — matching what fresh deals get at creation time.
  // milestone.status is DERIVED from its tasks by the recalc rollup (see
  // recalcMilestones.ts: a milestone is "Completed" only when ALL its tasks
  // are), so completing the milestone alone wouldn't stick — the next recalc
  // (triggered by any task edit / template cascade) would flip it back. So we
  // complete the underlying deal-side tasks too, then mark the milestones
  // Completed; that leaves a consistent state the rollup keeps Completed.
  // Only fires on the OFF→ON transition so re-saving an already-auto-complete
  // template never re-stamps progress. Non-blocking.
  let autoCompletedMilestones = 0;
  if (auto_complete === true && !previousAutoComplete) {
    try {
      const now = new Date().toISOString();

      // Every live deal-side milestone cloned from this stage template.
      const { data: dealMilestones } = await supabase
        .from("milestones")
        .select("id")
        .eq("stage_template_id", id)
        .eq("is_deleted", false);
      const milestoneIds = (dealMilestones ?? []).map((m) => m.id);

      if (milestoneIds.length > 0) {
        // 1. Complete every still-open task under those milestones. Guarding by
        //    status keeps already-Completed tasks' original completed_at intact.
        await supabase
          .from("tasks")
          .update({ status: "Completed", completed_at: now })
          .in("milestone_id", milestoneIds)
          .neq("status", "Completed")
          .eq("is_deleted", false);

        // 2. Mark the milestones themselves Completed. With all their tasks now
        //    done, this is exactly what the recalc rollup would compute, so the
        //    status is stable.
        const { data: completed } = await supabase
          .from("milestones")
          .update({ status: "Completed", completed_at: now })
          .in("id", milestoneIds)
          .neq("status", "Completed")
          .select("id");
        autoCompletedMilestones = completed?.length ?? 0;
      }
    } catch (acErr) {
      console.error("[StageTemplate PUT] Auto-complete cascade failed (non-blocking):", acErr);
    }
  }

  return NextResponse.json({ ...data, backfilledMilestones, autoCompletedMilestones });
}

// PATCH /api/admin/milestone-templates — batch reorder.
// Accepts { items: [{ id, order_index }, ...] } and only touches order_index.
// Deliberately skips the rename propagation / backfill that PUT runs (those are
// no-ops for an order-only change and would be wasteful to fire per dragged row);
// it does still mirror the new order onto already-created deal milestones so the
// customer portal ordering stays in sync.
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const items = body?.items;

  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items array is required" }, { status: 400 });
  }
  for (const it of items) {
    if (!it?.id || typeof it.order_index !== "number") {
      return NextResponse.json(
        { error: "Each item needs an id and a numeric order_index" },
        { status: 400 },
      );
    }
  }

  for (const it of items) {
    const { error } = await supabase
      .from("stage_templates")
      .update({ order_index: it.order_index })
      .eq("id", it.id);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Mirror the new order onto deal-side milestones (the portal reads
    // milestones.order_index directly). Non-blocking — the template reorder has
    // already succeeded.
    try {
      await supabase
        .from("milestones")
        .update({ order_index: it.order_index })
        .eq("stage_template_id", it.id)
        .eq("is_deleted", false);
    } catch (propErr) {
      console.error("[StageTemplate PATCH] order propagation failed (non-blocking):", propErr);
    }
  }

  return NextResponse.json({ success: true, updated: items.length });
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
