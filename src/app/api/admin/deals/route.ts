import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET() {
  const { data, error } = await supabase
    .from("deals")
    .select("*, tasks(id, status), leads(id, parent_lead_id, first_name, last_name)")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const deals = data ?? [];

  // Build a set of primary lead IDs that have co-purchasers pointing to them
  const primaryLeadIds = new Set<string>();
  for (const deal of deals) {
    const lead = deal.leads as any;
    if (lead?.parent_lead_id) {
      primaryLeadIds.add(lead.parent_lead_id);
    }
  }

  const result = deals.map((deal: any) => {
    const tasks = deal.tasks ?? [];
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: any) => t.status === "Completed").length;
    const lead = deal.leads as any;

    const isCoPurchaser = !!lead?.parent_lead_id;
    const hasCoPurchasers = lead ? primaryLeadIds.has(lead.id) : false;

    const { tasks: _tasks, leads: _leads, ...rest } = deal;
    return {
      ...rest,
      totalTasks,
      completedTasks,
      is_co_purchaser: isCoPurchaser,
      has_co_purchasers: hasCoPurchasers,
      lead_name: lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : null,
    };
  });

  return NextResponse.json(result);
}
