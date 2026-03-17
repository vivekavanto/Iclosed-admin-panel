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

  return NextResponse.json(data ?? []);
}
