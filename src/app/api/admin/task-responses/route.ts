import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");

  if (!dealId) {
    return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  }

  // Step 1: get all task IDs for this deal
  const { data: tasks, error: tasksError } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("deal_id", dealId);

  if (tasksError || !tasks?.length) {
    return NextResponse.json([]);
  }

  const taskIds = tasks.map((t) => t.id);

  // Step 2: get file-type responses for those tasks
  const { data, error } = await supabaseAdmin
    .from("task_responses")
    .select("task_id, file_name, file_url, field_type")
    .in("task_id", taskIds)
    .eq("field_type", "file");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Step 3: if file_url is null, look up from lead_corporate_docs via deal's lead_id
  const hasNullUrls = (data ?? []).some((d) => !d.file_url);
  if (hasNullUrls) {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (deal?.lead_id) {
      const { data: docs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("file_name, file_url")
        .eq("lead_id", deal.lead_id);

      if (docs?.length) {
        const docMap = new Map(docs.map((d) => [d.file_name, d.file_url]));
        for (const item of data ?? []) {
          if (!item.file_url && item.file_name) {
            item.file_url = docMap.get(item.file_name) ?? null;
          }
        }
      }
    }
  }

  return NextResponse.json(data ?? []);
}
