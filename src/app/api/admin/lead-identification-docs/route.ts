import supabaseAdmin from "@/lib/supabaseAdmin";
import { NextResponse } from "next/server";

/**
 * GET /api/admin/lead-identification-docs?lead_id=<id>
 * GET /api/admin/lead-identification-docs?lead_ids=<id,id,…>
 *
 * A lead's identification documents. `lead_ids` fetches a whole co-purchaser /
 * co-seller family in one round trip and additionally returns `docs_by_lead`
 * so the caller can scope each person's documents to their own row — unlike
 * /api/admin/lead-docs?deal_id=, which dedupes family docs by file_name and so
 * drops one person's file when two members upload the same filename.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lead_id = searchParams.get("lead_id");
    const lead_ids = searchParams.get("lead_ids");

    const ids = lead_ids
      ? [...new Set(lead_ids.split(",").map((s) => s.trim()).filter(Boolean))]
      : lead_id
        ? [lead_id]
        : [];

    if (ids.length === 0) {
      return NextResponse.json(
        { success: false, error: "lead_id or lead_ids is required" },
        { status: 400 },
      );
    }

    const { data, error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("id, lead_id, file_name, file_url, custom_type, created_at")
      .in("lead_id", ids)
      .eq("doc_type", "identification")
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    type IdDocRow = NonNullable<typeof data>[number];
    const docsByLead: Record<string, IdDocRow[]> = {};
    for (const id of ids) docsByLead[id] = [];
    for (const d of data ?? []) {
      (docsByLead[d.lead_id] ??= []).push(d);
    }

    return NextResponse.json({ success: true, docs: data ?? [], docs_by_lead: docsByLead });
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
