import { NextRequest, NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';

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

  return NextResponse.json(data, { status: 201 });
}

// PUT /api/admin/task-templates
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    const { id, leadType, roleType, name, order, deadlineRule, isApsTask, is_default, is_shared, stageTemplateId } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    // Capture the previous name BEFORE updating so we can propagate a rename to
    // the snapshot copies already created on deals (tasks.title is copied from
    // the template at lead-conversion time and never re-synced on its own).
    const { data: prevTemplate } = await supabase
      .from('task_templates')
      .select('name')
      .eq('id', id)
      .maybeSingle();
    const previousName: string | null = prevTemplate?.name ?? null;

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
        stage_template_id: stageTemplateId || null,
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

    return NextResponse.json(data);
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

    const { error } = await supabase
      .from('task_templates')
      .update({ is_deleted: true })
      .eq('id', id);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
