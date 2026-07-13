import { NextRequest, NextResponse } from 'next/server';
import supabaseAdmin from '@/lib/supabaseAdmin';

const supabase = supabaseAdmin;

// GET /api/admin/email-templates
export async function GET() {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('deleted', false)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// POST /api/admin/email-templates
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, body: emailBody, is_active, subject, shared_with_agent } = body;

  if (!name || !emailBody) {
    return NextResponse.json(
      { error: 'Name and body are required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('email_templates')
    .insert([{
      name,
      body: emailBody,
      is_active: is_active ?? true,
      subject: subject || null,
      shared_with_agent: shared_with_agent ?? false,
    }])
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data, { status: 201 });
}

// PUT /api/admin/email-templates
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, name, body: emailBody, is_active, subject, shared_with_agent } = body;

    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }

    const updateData: any = {};

    if (name !== undefined) updateData.name = name;
    if (emailBody !== undefined) updateData.body = emailBody;
    if (is_active !== undefined) updateData.is_active = is_active;
    if (subject !== undefined) updateData.subject = subject || null;
    // Lets the inline column checkbox persist by PUT-ing just { id, shared_with_agent }.
    if (shared_with_agent !== undefined) updateData.shared_with_agent = shared_with_agent;

    const { data, error } = await supabase
      .from("email_templates")
      .update(updateData)
      .eq("id", id)
      .select();

    if (error) {
      console.error(error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(data[0]);
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// DELETE /api/admin/email-templates?id=...
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    let id = searchParams.get('id');

    if (!id) {
      try {
        const body = await req.json();
        id = body?.id ?? null;
      } catch {
        // no body — fall through
      }
    }

    if (!id) {
      return NextResponse.json({ error: 'ID required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('email_templates')
      .update({ deleted: true, is_active: false })
      .eq('id', id)
      .select();

    if (error) {
      console.error(error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Template not found' }, { status: 404 });
    }

    // Unlink the deleted template from everything that still points at it.
    // The delete above is a soft delete, but stage_templates / milestones keep
    // their `email_template_id` FK, and the GET joins (`email_templates(id,
    // name)`) don't filter on `deleted` — so a deleted template keeps showing
    // on the milestone-templates page and on deal detail. The customer portal
    // is a separate repo, so display-side filtering can't cover every consumer;
    // nulling the references here is the only fix that reaches all of them.
    // Non-blocking — the template is already deleted regardless.
    let unlinkedStages = 0;
    let unlinkedMilestones = 0;
    try {
      const { data: stages } = await supabase
        .from('stage_templates')
        .update({ email_template_id: null })
        .eq('email_template_id', id)
        .select('id');
      unlinkedStages = stages?.length ?? 0;

      const { data: ms } = await supabase
        .from('milestones')
        .update({ email_template_id: null })
        .eq('email_template_id', id)
        .select('id');
      unlinkedMilestones = ms?.length ?? 0;
    } catch (unlinkErr) {
      console.error('[EmailTemplate DELETE] Unlink references failed (non-blocking):', unlinkErr);
    }

    return NextResponse.json({ success: true, id, unlinkedStages, unlinkedMilestones });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

