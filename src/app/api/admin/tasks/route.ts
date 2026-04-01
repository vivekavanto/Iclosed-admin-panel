import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");

  if (!dealId) {
    return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("tasks")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // ── Sync shared tasks to linked deals ────────────────────────────────────
    // If this task is shared and its status/completed changed, sync to co-purchaser deals
    if (data?.is_shared && data?.task_template_id && data?.deal_id &&
        (updates.status !== undefined || updates.completed !== undefined)) {
      try {
        await syncSharedTask(data);
      } catch (syncErr) {
        console.error("[TaskSync] Non-blocking sync error:", syncErr);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * Syncs a shared task's status to the same task in all linked co-purchaser deals.
 *
 * Linked deals are found via the lead relationship:
 *   deal → lead → root lead (coalesce parent_lead_id or self)
 *     → all leads in family → all their deals (excluding current)
 */
async function syncSharedTask(task: Record<string, any>) {
  const { deal_id, task_template_id, status, completed, completed_at } = task;

  // Step 1: Get the lead_id for this deal
  const { data: deal } = await supabase
    .from("deals")
    .select("lead_id")
    .eq("id", deal_id)
    .single();

  if (!deal?.lead_id) return;

  // Step 2: Get the root lead (primary)
  const { data: lead } = await supabase
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();

  if (!lead) return;

  const rootLeadId = lead.parent_lead_id ?? lead.id;

  // Step 3: Find all leads in the family
  const { data: familyLeads } = await supabase
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

  if (!familyLeads || familyLeads.length <= 1) return;

  const familyLeadIds = familyLeads.map((l) => l.id);

  // Step 4: Find all deals for those leads, excluding the current deal
  const { data: linkedDeals } = await supabase
    .from("deals")
    .select("id")
    .in("lead_id", familyLeadIds)
    .neq("id", deal_id);

  if (!linkedDeals || linkedDeals.length === 0) return;

  const linkedDealIds = linkedDeals.map((d) => d.id);

  // Step 5: Update the matching shared task in all linked deals
  const updatePayload: Record<string, any> = { status };
  if (completed !== undefined) {
    updatePayload.completed = completed;
    updatePayload.completed_at = completed ? (completed_at ?? new Date().toISOString()) : null;
  }

  const { error: syncError } = await supabase
    .from("tasks")
    .update(updatePayload)
    .eq("task_template_id", task_template_id)
    .eq("is_shared", true)
    .in("deal_id", linkedDealIds);

  if (syncError) {
    console.error("[TaskSync] Failed to sync shared task:", syncError.message);
  } else {
    console.log(`[TaskSync] Synced task (template: ${task_template_id}) to ${linkedDealIds.length} linked deal(s)`);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    // Remove any fields that don't exist in tasks
    const { client: _client, ...payload } = body;

    // Ensure empty strings for UUID FK fields are sent as null
    if (!payload.milestone_id) payload.milestone_id = null;
    if (!payload.task_template_id) payload.task_template_id = null;

    const { data, error } = await supabase
      .from("tasks")
      .insert([payload])
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
