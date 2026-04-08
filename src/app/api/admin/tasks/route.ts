import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { recalcMilestonesForFamily } from "@/lib/recalcMilestones";

const supabase = supabaseAdmin;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");

  if (!dealId) {
    return NextResponse.json({ error: "deal_id is required" }, { status: 400 });
  }

  // Shared tasks are a single source of truth on the primary purchaser's deal.
  // Co-purchaser deals should still show shared tasks, but fetched from the primary deal.
  let primaryDealId = dealId;

  try {
    const { data: deal } = await supabase
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (deal?.lead_id) {
      const { data: lead } = await supabase
        .from("leads")
        .select("id, parent_lead_id")
        .eq("id", deal.lead_id)
        .single();

      const rootLeadId = lead?.parent_lead_id ?? lead?.id;
      if (rootLeadId) {
        const { data: rootDeal } = await supabase
          .from("deals")
          .select("id")
          .eq("lead_id", rootLeadId)
          .maybeSingle();
        if (rootDeal?.id) primaryDealId = rootDeal.id;
      }
    }
  } catch {
    // Non-blocking: fallback to dealId
  }

  const [{ data: sharedTasks, error: sharedErr }, { data: personalTasks, error: personalErr }] = await Promise.all([
    supabase
      .from("tasks")
      .select("*")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .order("created_at", { ascending: true }),
    supabase
      .from("tasks")
      .select("*")
      .eq("deal_id", dealId)
      .or("is_shared.is.null,is_shared.eq.false")
      .order("created_at", { ascending: true }),
  ]);

  if (sharedErr) return NextResponse.json({ error: sharedErr.message }, { status: 500 });
  if (personalErr) return NextResponse.json({ error: personalErr.message }, { status: 500 });

  if (dealId !== primaryDealId && sharedTasks && sharedTasks.length > 0) {
    try {
      const { data: familyMilestones } = await supabase
        .from("milestones")
        .select("id, deal_id, stage_template_id")
        .in("deal_id", [dealId, primaryDealId]);

      if (familyMilestones) {
        const primaryMsMap = new Map();
        const localMsMap = new Map();

        familyMilestones.forEach(m => {
          if (m.deal_id === primaryDealId) primaryMsMap.set(m.id, m.stage_template_id);
          if (m.deal_id === dealId) localMsMap.set(m.stage_template_id, m.id);
        });

        for (const task of sharedTasks) {
          if (task.milestone_id) {
            const templId = primaryMsMap.get(task.milestone_id);
            if (templId) {
              const localId = localMsMap.get(templId);
              if (localId) {
                task.milestone_id = localId;
              }
            }
          }
        }
      }
    } catch {}
  }

  return NextResponse.json([...(sharedTasks ?? []), ...(personalTasks ?? [])]);
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
    const { id, assignee, status, completed, document_url } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Step 1: Load the task to decide shared vs personal update rules
    const { data: existingTask, error: fetchError } = await supabase
      .from("tasks")
      .select("id, deal_id, is_shared, assignee, task_template_id")
      .eq("id", id)
      .single();

    if (fetchError || !existingTask) {
      return NextResponse.json({ success: false, error: fetchError?.message ?? "Task not found" }, { status: 404 });
    }

    // Step 2: Build a strict update payload (avoid accidental logic changes)
    const updates: Record<string, any> = {};
    if (status !== undefined) updates.status = status;
    if (completed !== undefined) updates.completed = completed;
    if (body.completed_at !== undefined) updates.completed_at = body.completed_at;
    if (body.due_date !== undefined) updates.due_date = body.due_date;
    if (document_url !== undefined) updates.document_url = document_url;

    // Nothing to update
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: true, data: existingTask });
    }

    // Step 3: Apply update rules
    // - Shared tasks: update the primary deal's shared task row (single source of truth)
    // - Personal tasks: update by task_id + assignee (user-specific)
    let updateQuery = supabase.from("tasks").update(updates);

    if (existingTask.is_shared) {
      if (!existingTask.task_template_id) {
        return NextResponse.json(
          { success: false, error: "task_template_id is required for shared task updates" },
          { status: 400 },
        );
      }

      // Resolve primary deal for this lead family
      let primaryDealId = existingTask.deal_id;
      try {
        const { data: deal } = await supabase
          .from("deals")
          .select("lead_id")
          .eq("id", existingTask.deal_id)
          .single();

        if (deal?.lead_id) {
          const { data: lead } = await supabase
            .from("leads")
            .select("id, parent_lead_id")
            .eq("id", deal.lead_id)
            .single();

          const rootLeadId = lead?.parent_lead_id ?? lead?.id;
          if (rootLeadId) {
            const { data: rootDeal } = await supabase
              .from("deals")
              .select("id")
              .eq("lead_id", rootLeadId)
              .maybeSingle();
            if (rootDeal?.id) primaryDealId = rootDeal.id;
          }
        }
      } catch {
        // Non-blocking: fallback to existingTask.deal_id
      }

      // Update the primary deal's shared task (single source of truth)
      updateQuery = updateQuery
        .eq("deal_id", primaryDealId)
        .eq("task_template_id", existingTask.task_template_id)
        .eq("is_shared", true);

      const { data, error } = await updateQuery.select().single();

      if (error) {
        return NextResponse.json({ success: false, error: error.message }, { status: 400 });
      }

      // Also sync to ALL other family deals' shared tasks
      try {
        const familyDealIds = await getFamilyDealIds(primaryDealId);
        const otherDealIds = familyDealIds.filter((did) => did !== primaryDealId);

        if (otherDealIds.length > 0) {
          await supabase
            .from("tasks")
            .update(updates)
            .eq("task_template_id", existingTask.task_template_id)
            .eq("is_shared", true)
            .in("deal_id", otherDealIds);
        }

        // Recalculate milestone status for ALL family deals
        // When a shared task changes, milestones on linked deals may need updating
        if (updates.status !== undefined || updates.completed !== undefined) {
          await recalcMilestonesForFamily(familyDealIds, primaryDealId);
        }
      } catch {
        // Non-blocking
      }

      return NextResponse.json({ success: true, data });
    } else {
      const effectiveAssignee = assignee ?? existingTask.assignee;
      if (effectiveAssignee) {
        updateQuery = updateQuery.eq("id", id).eq("assignee", effectiveAssignee);
      } else {
        updateQuery = updateQuery.eq("id", id);
      }
    }

    const { data, error } = await updateQuery.select().single();

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
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
