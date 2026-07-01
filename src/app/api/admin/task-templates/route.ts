import { NextRequest, NextResponse, after } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';
import { repointTasksForTemplate, backfillTaskForTemplate, restructureSharedTaskRows, finishSharedTaskReconcile, reconcileSharedTasksForTemplate } from '@/lib/reconcileDealMilestoneLinks';

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
      .select('name, stage_template_id, is_default, is_shared')
      .eq('id', id)
      .maybeSingle();
    const previousName: string | null = prevTemplate?.name ?? null;
    const oldStageTemplateId: string | null = prevTemplate?.stage_template_id ?? null;
    const newStageTemplateId: string | null = stageTemplateId || null;
    const previousIsDefault: boolean = prevTemplate?.is_default ?? false;
    const previousIsShared: boolean = prevTemplate?.is_shared ?? false;

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

    const newIsDefault = is_default ?? false;
    const newIsShared = is_shared ?? false;
    const sharedToggled = previousIsShared !== newIsShared;

    // Toggling `is_shared` restructures the already-seeded rows: a shared task is
    // ONE row on the primary deal (shown once family-wide) while a personal task
    // is one row PER family member. That reshaping is what the deal page renders,
    // so for a PURE is_shared toggle (is_default unchanged & on) we do it
    // SYNCHRONOUSLY here — a few indexed UPDATEs — so the admin's immediate
    // reload shows the collapsed/expanded shape instead of the stale one. Only
    // the slow seed+recalc half defers to `after()`. When is_default ALSO changed
    // in this same edit, its un/re-seed runs inside `after()` first, so we leave
    // the WHOLE reconcile deferred (below) to operate on that freshly seeded row
    // set rather than racing it here.
    const fastShared = sharedToggled && previousIsDefault && newIsDefault;
    let fastSharedCoClientDealIds: string[] | null = null;
    if (fastShared) {
      try {
        fastSharedCoClientDealIds = await restructureSharedTaskRows(id);
      } catch (sharedErr) {
        console.error('[TaskTemplate PUT] is_shared restructure failed (non-blocking):', sharedErr);
      }
    }

    // The template row itself is now saved — that's the admin's "save". The
    // deal-side reconciliation below (rename propagation, stage repoint,
    // backfill) pages through every deal of this lead type and recalcs each
    // family, which is slow enough that awaiting it inline made the modal hang
    // on "Saving..." and could exceed the request timeout. None of it feeds the
    // form's view, so we run it AFTER the response is flushed via `after()`.
    // Each step stays individually guarded so one failure can't abort the rest.
    after(async () => {
      // Propagate a rename to every already-created task that still carries the
      // old template name. We only touch rows whose title still equals the old
      // name so per-deal manual title edits (done via the tasks PATCH route) are
      // preserved. This is what makes the rename reflect in the customer portal,
      // which reads tasks.title directly.
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
      // the old milestone.
      if (oldStageTemplateId !== newStageTemplateId) {
        try {
          await repointTasksForTemplate(id, newStageTemplateId);
        } catch (cascadeErr) {
          console.error('[TaskTemplate PUT] Milestone link cascade failed (non-blocking):', cascadeErr);
        }
      }

      // Turning `is_default` OFF (true→false) un-seeds the task from existing
      // deals: a default task was auto-cloned onto every deal, so making it
      // non-default should pull it back off active dashboards, not just stop it
      // appearing on future conversions. Mirrors the DELETE cascade — soft-delete
      // the cloned tasks and KEEP task_responses, so re-enabling default (which
      // re-runs the backfill below) cleanly restores them. Skip the backfill on
      // this same edit since is_default is now false (it would early-return
      // anyway). Only fires on the true→false transition.
      if (previousIsDefault && !newIsDefault) {
        try {
          await supabase
            .from('tasks')
            .update({ is_deleted: true })
            .eq('task_template_id', id)
            .eq('is_deleted', false);
        } catch (unseedErr) {
          console.error('[TaskTemplate PUT] Un-seed cascade failed (non-blocking):', unseedErr);
        }
      } else {
        // Re-enabling default (OFF→ON) must first RESTORE the deal-side tasks our
        // un-seed soft-deleted, then backfill the rest. The restore is essential:
        // backfillTaskForTemplate's idempotency check counts soft-deleted rows as
        // "already present" (it doesn't filter is_deleted), so without un-deleting
        // them first it would skip exactly the deals we just un-seeded and the
        // task would never come back. Restoring (vs. inserting fresh) also keeps
        // each task's existing task_responses attached — the symmetric inverse of
        // the soft-delete above.
        if (!previousIsDefault && newIsDefault) {
          try {
            await supabase
              .from('tasks')
              .update({ is_deleted: false })
              .eq('task_template_id', id)
              .eq('is_deleted', true);
          } catch (restoreErr) {
            console.error('[TaskTemplate PUT] Re-seed restore failed (non-blocking):', restoreErr);
          }
        }

        // Seed this task onto existing deals that are missing it — mirroring the
        // POST backfill. Without this, a template that becomes eligible only via
        // an edit (e.g. `is_default` flipped on, or a non-default task created
        // earlier and now marked default) would never reach already-active deals;
        // it'd only show on FUTURE conversions. backfillTaskForTemplate is
        // idempotent (deals already carrying this task_template_id are skipped)
        // and self-gates on is_default / is_shared, so it's safe to call on every
        // edit. The repoint above handles deals that HAVE the task; the restore
        // above handles deals we un-seeded; this handles deals that NEVER had it.
        try {
          await backfillTaskForTemplate(id);
        } catch (backfillErr) {
          console.error('[TaskTemplate PUT] Task backfill failed (non-blocking):', backfillErr);
        }
      }

      // Finish the is_shared reconcile. Two cases, both gated on the task still
      // being seeded (is_default) — if default was just turned off, the un-seed
      // above already removed the rows and reconciliation would wrongly restore
      // them:
      //  - Pure is_shared toggle: the rows were already restructured
      //    synchronously before the response; only the slow seed+recalc remains.
      //  - is_shared changed alongside is_default: the un/re-seed just ran above,
      //    so run the FULL reconcile now against that freshly seeded row set.
      if (fastShared) {
        try {
          await finishSharedTaskReconcile(id, fastSharedCoClientDealIds);
        } catch (sharedErr) {
          console.error('[TaskTemplate PUT] is_shared finish failed (non-blocking):', sharedErr);
        }
      } else if (sharedToggled && newIsDefault) {
        try {
          await reconcileSharedTasksForTemplate(id);
        } catch (sharedErr) {
          console.error('[TaskTemplate PUT] is_shared cascade failed (non-blocking):', sharedErr);
        }
      }
    });

    return NextResponse.json({ ...data });
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
