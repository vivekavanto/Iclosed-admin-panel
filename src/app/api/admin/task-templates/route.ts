import { NextRequest, NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';
import { repointTasksForTemplate, backfillTaskForTemplate } from '@/lib/reconcileDealMilestoneLinks';

const supabase = supabaseAdmin;

// GET /api/admin/task-templates
export async function GET() {
  const { data, error } = await supabase
    .from('task_templates')
    .select('*, stage_templates(id, name)')
    .eq('is_deleted', false)
    .order('lead_type', { ascending: true })
    .order('order_index', { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// POST /api/admin/task-templates
export async function POST(req: NextRequest) {
  const body = await req.json();

  const { leadType, roleType, name, order, deadlineRule, isApsTask, is_default, is_shared, stageTemplateId } = body;

  if (!leadType || !name || order === undefined) {
    return NextResponse.json({ error: 'Required fields missing' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('task_templates')
    .insert([
      {
        lead_type: leadType,
        role_type: roleType || 'Client',
        name,
        order_index: order,
        deadline_rule: deadlineRule || null,
        is_aps_task: isApsTask ?? false,
        is_default: is_default ?? false,
        is_shared: is_shared ?? false,
        stage_template_id: stageTemplateId || null,
      },
    ])
    .select('*, stage_templates(id, name)')
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Seed this brand-new task onto every existing deal of its lead_type so it
  // shows up on already-active customer dashboards, not just future deals —
  // mirroring the milestone-template POST backfill. Only default templates are
  // seeded (matching conversion). Non-blocking: the template was created fine
  // regardless.
  let backfilledTasks = 0;
  try {
    const res = await backfillTaskForTemplate(data.id);
    backfilledTasks = res.created;
  } catch (backfillErr) {
    console.error('[TaskTemplate POST] Task backfill failed (non-blocking):', backfillErr);
  }

  return NextResponse.json({ ...data, backfilledTasks }, { status: 201 });
}

// PUT /api/admin/task-templates
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    const { id, leadType, roleType, name, order, deadlineRule, isApsTask, is_default, is_shared, stageTemplateId } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    // Capture the previous name + stage BEFORE updating: name drives the rename
    // propagation below (tasks.title is a per-deal snapshot), and stage drives
    // the milestone-link cascade (tasks.milestone_id is also a snapshot).
    const { data: prevTemplate } = await supabase
      .from('task_templates')
      .select('name, stage_template_id')
      .eq('id', id)
      .maybeSingle();
    const previousName: string | null = prevTemplate?.name ?? null;
    const oldStageTemplateId: string | null = prevTemplate?.stage_template_id ?? null;
    const newStageTemplateId: string | null = stageTemplateId || null;

    const { data, error } = await supabase
      .from('task_templates')
      .update({
        lead_type: leadType,
        role_type: roleType,
        name,
        order_index: order,
        deadline_rule: deadlineRule || null,
        is_aps_task: isApsTask,
        is_default: is_default ?? false,
        is_shared: is_shared ?? false,
        stage_template_id: newStageTemplateId,
      })
      .eq('id', id)
      .select('*, stage_templates(id, name)')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Propagate a rename to every already-created task that still carries the
    // old template name. We only touch rows whose title still equals the old
    // name so per-deal manual title edits (done via the tasks PATCH route) are
    // preserved. This is what makes the rename reflect in the customer portal,
    // which reads tasks.title directly. Non-blocking: a failed propagation
    // shouldn't fail the template update itself.
    if (name && previousName && name !== previousName) {
      try {
        await supabase
          .from('tasks')
          .update({ title: name })
          .eq('task_template_id', id)
          .eq('title', previousName)
          .eq('is_deleted', false);
      } catch (propErr) {
        console.error('[TaskTemplate PUT] Title propagation failed (non-blocking):', propErr);
      }
    }

    // Cascade a stage change onto existing deals: repoint every live task
    // cloned from this template to the milestone matching the new stage
    // (creating that milestone where a deal lacks it). Without this, only NEW
    // deals would pick up the new mapping and existing deals would keep driving
    // the old milestone. Non-blocking — the template save already succeeded.
    let repointedTasks = 0;
    let createdMilestones = 0;
    if (oldStageTemplateId !== newStageTemplateId) {
      try {
        const res = await repointTasksForTemplate(id, newStageTemplateId);
        repointedTasks = res.repointed;
        createdMilestones = res.created;
      } catch (cascadeErr) {
        console.error('[TaskTemplate PUT] Milestone link cascade failed (non-blocking):', cascadeErr);
      }
    }

    return NextResponse.json({ ...data, repointedTasks, createdMilestones });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// PATCH /api/admin/task-templates — batch reorder.
// Accepts { items: [{ id, order_index }, ...] } and only touches order_index.
// Mirrors the milestone reorder endpoint and skips PUT's rename/stage cascades,
// which are no-ops for an order-only change. It also mirrors the new order onto
// every existing deal's cloned tasks (tasks.order_index) so the deal view and
// customer portal re-sort to match — order_index is identical across all deals'
// copies of a template, so a single update per template covers the whole family.
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const items = body?.items;

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'items array is required' }, { status: 400 });
    }
    for (const it of items) {
      if (!it?.id || typeof it.order_index !== 'number') {
        return NextResponse.json(
          { error: 'Each item needs an id and a numeric order_index' },
          { status: 400 },
        );
      }
    }

    for (const it of items) {
      const { error } = await supabase
        .from('task_templates')
        .update({ order_index: it.order_index })
        .eq('id', it.id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Propagate the new order onto already-created deal tasks (the portal
      // reads tasks.order_index directly). Non-blocking — the template reorder
      // has already succeeded.
      try {
        await supabase
          .from('tasks')
          .update({ order_index: it.order_index })
          .eq('task_template_id', it.id)
          .eq('is_deleted', false);
      } catch (propErr) {
        console.error('[TaskTemplate PATCH] order propagation failed (non-blocking):', propErr);
      }
    }

    return NextResponse.json({ success: true, updated: items.length });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/admin/task-templates
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    // Soft cascade: tasks are per-deal SNAPSHOTS cloned from this template at
    // lead-conversion time (see convertLead.ts), not live references. Deleting
    // only the template row would hide the task from FUTURE deals while leaving
    // it on every EXISTING deal's dashboard. So we also soft-delete the cloned
    // tasks here. task_responses are intentionally kept intact so the whole
    // cascade stays reversible (flip is_deleted back to false to restore).
    let deletedTasks = 0;
    const { data: clonedTasks, error: taskFetchErr } = await supabase
      .from('tasks')
      .update({ is_deleted: true }, { count: 'exact' })
      .eq('task_template_id', id)
      .eq('is_deleted', false)
      .select('id');
    if (taskFetchErr) {
      return NextResponse.json({ error: taskFetchErr.message }, { status: 500 });
    }
    deletedTasks = clonedTasks?.length ?? 0;

    const { error } = await supabase
      .from('task_templates')
      .update({ is_deleted: true })
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, deleted_tasks: deletedTasks });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
