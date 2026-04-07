import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

/**
 * Finds all deal IDs in the same co-purchaser family as the given deal.
 */
async function getFamilyDealIds(dealId: string): Promise<string[]> {
  try {
    const { data: deal } = await supabase
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (!deal?.lead_id) return [dealId];

    const { data: lead } = await supabase
      .from("leads")
      .select("id, parent_lead_id")
      .eq("id", deal.lead_id)
      .single();

    if (!lead) return [dealId];

    const rootLeadId = lead.parent_lead_id ?? lead.id;

    const { data: familyLeads } = await supabase
      .from("leads")
      .select("id")
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

    if (!familyLeads || familyLeads.length <= 1) return [dealId];

    const { data: familyDeals } = await supabase
      .from("deals")
      .select("id")
      .in("lead_id", familyLeads.map((l) => l.id));

    if (!familyDeals) return [dealId];
    return familyDeals.map((d) => d.id);
  } catch {
    return [dealId];
  }
}

/**
 * Syncs a milestone status update to matching milestones in all linked deals.
 * Matches by stage_template_id.
 */
async function syncMilestoneToLinkedDeals(
  milestone: Record<string, any>,
  updates: Record<string, any>,
) {
  const { id: milestoneId, deal_id, stage_template_id } = milestone;
  if (!deal_id || !stage_template_id) return;

  // Only sync milestones that have shared tasks under them.
  // Personal milestones (e.g., Personal Information, Identification) should NOT sync.
  const { data: sharedTasksUnder } = await supabase
    .from("tasks")
    .select("id")
    .eq("milestone_id", milestoneId)
    .eq("is_shared", true)
    .limit(1);

  if (!sharedTasksUnder || sharedTasksUnder.length === 0) return;

  const familyDealIds = await getFamilyDealIds(deal_id);
  const linkedDealIds = familyDealIds.filter((id) => id !== deal_id);
  if (linkedDealIds.length === 0) return;

  const syncPayload: Record<string, any> = {};
  if (updates.status !== undefined) syncPayload.status = updates.status;
  if (updates.completed_at !== undefined) syncPayload.completed_at = updates.completed_at;
  if (updates.email_sent !== undefined) syncPayload.email_sent = updates.email_sent;
  if (updates.milestone_date !== undefined) syncPayload.milestone_date = updates.milestone_date;

  if (Object.keys(syncPayload).length === 0) return;

  const { error } = await supabase
    .from("milestones")
    .update(syncPayload)
    .eq("stage_template_id", stage_template_id)
    .in("deal_id", linkedDealIds);

  if (error) {
    console.error("[MilestoneSync] Failed:", error.message);
  } else {
    console.log(`[MilestoneSync] Synced milestone (template: ${stage_template_id}) to ${linkedDealIds.length} linked deal(s)`);
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");

  if (!dealId) {
    return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("milestones")
    .select("*")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json(data);
}

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const { data, error } = await supabase
      .from("milestones")
      .insert([body])
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

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("milestones")
      .update(updates)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Sync status/completed_at changes to linked co-purchaser deals
    if (data?.stage_template_id &&
        (updates.status !== undefined || updates.completed_at !== undefined || updates.milestone_date !== undefined)) {
      try {
        await syncMilestoneToLinkedDeals(data, updates);
      } catch (syncErr) {
        console.error("[MilestoneSync] Non-blocking error:", syncErr);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("milestones")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
