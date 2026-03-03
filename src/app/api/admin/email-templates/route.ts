import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

// GET /api/admin/email-templates
export async function GET() {
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

// POST /api/admin/email-templates
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, body: emailBody, is_active } = body;

  if (!name || !emailBody) {
    return NextResponse.json(
      { error: 'Name and body are required' },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from('email_templates')
    .insert([{ name, body: emailBody, is_active: is_active ?? true }])
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
    const { id, name, body: emailBody, is_active } = body;

    if (!id) {
      return NextResponse.json({ error: "ID required" }, { status: 400 });
    }

    const updateData: any = {};

    if (name !== undefined) updateData.name = name;
    if (emailBody !== undefined) updateData.body = emailBody;
    if (is_active !== undefined) updateData.is_active = is_active;

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

