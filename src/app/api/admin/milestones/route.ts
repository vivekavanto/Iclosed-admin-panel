import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

const supabase = supabaseAdmin;

/**
 * Syncs a milestone status update to matching milestones in all linked deals.
 * Matches by stage_template_id.
 */
async function syncMilestoneToLinkedDeals(
  milestone: Record<string, any>,
  updates: Record<string, any>,
): Promise<{ mirroredMilestones: number; mirroredTasks: number }> {
  const { id: milestoneId, deal_id, stage_template_id } = milestone;
  if (!deal_id || !stage_template_id) return { mirroredMilestones: 0, mirroredTasks: 0 };

  const familyDealIds = await getFamilyDealIds(deal_id);
  const linkedDealIds = familyDealIds.filter((id) => id !== deal_id);
  if (linkedDealIds.length === 0) return { mirroredMilestones: 0, mirroredTasks: 0 };

  // Find the milestones in the family with the same stage_template_id
  const { data: familyMilestones } = await supabase
    .from("milestones")
    .select("id")
    .eq("stage_template_id", stage_template_id)
    .in("deal_id", familyDealIds);

  const familyMilestoneIds = familyMilestones?.map(m => m.id) || [milestoneId];

  let mirroredMilestones = 0;
  let mirroredTasks = 0;

  const syncPayload: Record<string, any> = {};
  if (updates.status !== undefined) syncPayload.status = updates.status;
  if (updates.completed_at !== undefined) syncPayload.completed_at = updates.completed_at;
  if (updates.email_sent !== undefined) syncPayload.email_sent = updates.email_sent;
  if (updates.milestone_date !== undefined) syncPayload.milestone_date = updates.milestone_date;

  if (Object.keys(syncPayload).length > 0) {
    const { data: mirroredRows, error } = await supabase
      .from("milestones")
      .update(syncPayload)
      .eq("stage_template_id", stage_template_id)
      .in("deal_id", linkedDealIds)
      .select("id");

    if (error) {
      console.error("[MilestoneSync] Failed:", error.message);
    } else {
      mirroredMilestones = mirroredRows?.length ?? 0;
      console.log(`[MilestoneSync] Synced milestone (template: ${stage_template_id}) to ${mirroredMilestones} linked deal(s)`);
    }
  }

  // Cascade the status to the tasks under the linked milestones
  if (updates.status) {
    const isCompleted = updates.status === "Completed";
    const linkedMilestoneIds = familyMilestoneIds.filter(id => id !== milestoneId);
    
    if (linkedMilestoneIds.length > 0) {
      const taskUpdatePayload: Record<string, any> = {
        status: updates.status,
        completed: isCompleted,
        completed_at: isCompleted ? (updates.completed_at || new Date().toISOString()) : null,
      };

      // Only cascade to shared tasks on linked deals — personal tasks are independent per person
      const { data: mirroredTaskRows, error: taskError } = await supabase
        .from("tasks")
        .update(taskUpdatePayload)
        .in("milestone_id", linkedMilestoneIds)
        .eq("is_shared", true)
        .select("id");

      if (taskError) console.error("[MilestoneSync Tasks] Failed:", taskError.message);
      else mirroredTasks = mirroredTaskRows?.length ?? 0;
    }
  }

  return { mirroredMilestones, mirroredTasks };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");

  if (!dealId) {
    return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  }

  // Order by order_index — the canonical mortgage-stage sequence copied from
  // stage_templates.order_index at creation (see convertLead.ts). This is the
  // same order the client portal shows; created_at is only a stable tiebreaker
  // for rows that share (or lack) an order_index. Previously this ordered by
  // created_at alone, which let the admin list drift out of stage order.
  const { data, error } = await supabase
    .from("milestones")
    .select("*, stage_templates(lead_type)")
    .eq("deal_id", dealId)
    .eq("is_deleted", false)
    .order("order_index", { ascending: true, nullsFirst: false })
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

    // Batch reorder: { items: [{ id, order_index }] }. Persists a per-deal
    // milestone order set by the deal-detail drag handles — only touches
    // order_index and skips the linked-deal status sync below.
    if (Array.isArray(body.items)) {
      for (const it of body.items) {
        if (!it?.id || typeof it.order_index !== "number") continue;
        const { error } = await supabase
          .from("milestones")
          .update({ order_index: it.order_index })
          .eq("id", it.id);
        if (error) {
          return NextResponse.json({ success: false, error: error.message }, { status: 400 });
        }
      }
      return NextResponse.json({ success: true, reordered: body.items.length });
    }

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
    let mirroredMilestones = 0;
    let mirroredTasks = 0;
    if (data?.stage_template_id &&
        (updates.status !== undefined || updates.completed_at !== undefined || updates.milestone_date !== undefined)) {
      try {
        const result = await syncMilestoneToLinkedDeals(data, updates);
        mirroredMilestones = result.mirroredMilestones;
        mirroredTasks = result.mirroredTasks;
      } catch (syncErr) {
        console.error("[MilestoneSync] Non-blocking error:", syncErr);
      }
    }

    return NextResponse.json({ success: true, data, mirroredMilestones, mirroredTasks });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/milestones?id=...
 *
 * SOFT delete: marks the milestone `is_deleted=true` so it disappears from both
 * the admin panel and the customer portal, but the row (and any tasks under it)
 * stay intact. Reversible with `UPDATE milestones SET is_deleted=false`.
 */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const { error } = await supabase
    .from("milestones")
    .update({ is_deleted: true })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
