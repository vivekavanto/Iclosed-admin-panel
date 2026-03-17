import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const leadId = searchParams.get("lead_id");

  if (!leadId) {
    return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("*")
    .eq("lead_id", leadId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data ?? []);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { lead_id, doc_type, custom_type, file_url, file_name } = body;

    if (!lead_id) {
      return NextResponse.json({ error: "lead_id is required" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .insert({ lead_id, doc_type, custom_type, file_url, file_name })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
