import supabaseAdmin from "@/lib/supabaseAdmin";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lead_id = searchParams.get("lead_id");

    if (!lead_id) {
      return NextResponse.json({ success: false, error: "lead_id is required" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("id, file_name, file_url, custom_type, created_at")
      .eq("lead_id", lead_id)
      .eq("doc_type", "identification")
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true, docs: data ?? [] });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .delete()
      .eq("id", id)
      .eq("doc_type", "identification");

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
