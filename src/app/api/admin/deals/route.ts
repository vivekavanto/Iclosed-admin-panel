import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data, error } = await supabase
    .from("deals")
    .select("*, tasks(id, status)")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const result = (data ?? []).map((deal: any) => {
    const tasks = deal.tasks ?? [];
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: any) => t.status === "Completed").length;
    const { tasks: _tasks, ...rest } = deal;
    return { ...rest, totalTasks, completedTasks };
  });

  return NextResponse.json(result);
}