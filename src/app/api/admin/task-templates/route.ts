import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

// GET /api/admin/task-templates
export async function GET() {
  const { data, error } = await supabase
    .from('task_templates')
    .select('*')
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

  const { leadType, roleType, name, order, deadlineRule, isApsTask } = body;

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
      },
    ])
    .select()
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

    const { id, leadType, roleType, name, order, deadlineRule, isApsTask } = body;

    if (!id) {
      return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('task_templates')
      .update({
        lead_type: leadType,
        role_type: roleType,
        name,
        order_index: order,
        deadline_rule: deadlineRule || null,
        is_aps_task: isApsTask,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
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
