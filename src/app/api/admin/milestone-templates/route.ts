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
  const { name, description, lead_type, order_index, role, is_shared, email_template_id } = body;

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
  const { id, name, description, lead_type, order_index, role, is_shared, email_template_id } = body;

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

  if (!id) {
    return NextResponse.json({ error: "ID is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("stage_templates")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
