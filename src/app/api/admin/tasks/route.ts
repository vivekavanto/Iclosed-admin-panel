import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { recalcMilestonesForFamily } from "@/lib/recalcMilestones";
import { findFamilySharedTaskPeers } from "@/lib/findFamilySharedTaskPeers";

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
      .select("*, task_templates(lead_type)")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .order("created_at", { ascending: true }),
    supabase
      .from("tasks")
      .select("*, task_templates(lead_type)")
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

/**
 * DELETE /api/admin/tasks?id=...
 *
 * Cascades through the task's filled-in details so the deal returns to a
 * clean slate (no orphaned responses, no stale APS doc that would warn
 * "already exists" on the next upload).
 *
 * For shared (synced) tasks, the deletion mirrors across the entire
 * co-purchaser/co-seller family — matching how PATCH already mirrors
 * updates. For APS tasks (template flagged `is_aps_task=true`), the
 * family-wide APS rows in `lead_corporate_docs` are also wiped.
 *
 * Blob bytes in Vercel Blob are intentionally left in place — same
 * orphan policy as the rest of this codebase.
 */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // 1. Load the task we're deleting so we know its shared/APS status and
  //    can resolve the family scope.
  const { data: task, error: taskError } = await supabase
    .from("tasks")
    .select("id, deal_id, is_shared, task_template_id")
    .eq("id", id)
    .single();

  if (taskError || !task) {
    return NextResponse.json(
      { success: false, error: taskError?.message ?? "Task not found" },
      { status: 404 },
    );
  }

  // 2. Determine APS-ness via the template (so we can wipe lead_corporate_docs).
  let isAps = false;
  if (task.task_template_id) {
    const { data: tmpl } = await supabase
      .from("task_templates")
      .select("is_aps_task")
      .eq("id", task.task_template_id)
      .single();
    isAps = Boolean(tmpl?.is_aps_task);
  }

  // 3. Collect the set of task IDs to delete + the set of deal IDs touched.
  //    For template-backed tasks we ALWAYS scan the entire family — the
  //    unique constraint `tasks_deal_task_template_unique` covers
  //    (deal_id, task_template_id) regardless of is_shared, so a leftover
  //    sibling on a co-purchaser/co-seller deal would block recreation.
  //    Free-form tasks (no template_id) stay scoped to the single deal.
  let affectedDealIds: string[] = task.task_template_id
    ? await getFamilyDealIds(task.deal_id)
    : [task.deal_id];

  const taskIdSet = new Set<string>([id]);

  if (task.task_template_id) {
    const { data: matchingTasks } = await supabase
      .from("tasks")
      .select("id, deal_id")
      .eq("task_template_id", task.task_template_id)
      .in("deal_id", affectedDealIds);

    for (const t of matchingTasks ?? []) {
      taskIdSet.add(t.id);
    }
    if (matchingTasks && matchingTasks.length > 0) {
      affectedDealIds = [...new Set(matchingTasks.map((t) => t.deal_id))];
    }
  }

  const taskIdsToDelete = [...taskIdSet];

  // 4. Wipe filled-in details for every task in scope.
  const { error: respError } = await supabase
    .from("task_responses")
    .delete()
    .in("task_id", taskIdsToDelete);
  if (respError) {
    return NextResponse.json(
      { success: false, error: `Failed to clear task responses: ${respError.message}` },
      { status: 500 },
    );
  }

  // 5. For APS tasks, also wipe the family-wide APS rows in
  //    lead_corporate_docs so a fresh upload starts from a clean slate.
  if (isAps) {
    const { data: familyDeals } = await supabase
      .from("deals")
      .select("lead_id")
      .in("id", affectedDealIds);
    const familyLeadIds = [
      ...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean)),
    ];

    if (familyLeadIds.length > 0) {
      const { error: docError } = await supabase
        .from("lead_corporate_docs")
        .delete()
        .in("lead_id", familyLeadIds)
        .or(
          "doc_type.eq.aps,doc_type.eq.aps_purchase,doc_type.eq.aps_sale,custom_type.ilike.%APS%",
        );
      if (docError) {
        return NextResponse.json(
          { success: false, error: `Failed to clear APS docs: ${docError.message}` },
          { status: 500 },
        );
      }
    }
  }

  // 6. Delete the task row(s) themselves.
  const { error: deleteError } = await supabase
    .from("tasks")
    .delete()
    .in("id", taskIdsToDelete);
  if (deleteError) {
    return NextResponse.json(
      { success: false, error: deleteError.message },
      { status: 500 },
    );
  }

  // 7. Milestone status depends on task completion — recalc for any deal
  //    that lost a task. Non-blocking; a stale milestone is recoverable.
  try {
    const primaryDealId = task.deal_id;
    await recalcMilestonesForFamily(affectedDealIds, primaryDealId);
  } catch {
    // intentionally non-blocking
  }

  return NextResponse.json({
    success: true,
    deleted_tasks: taskIdsToDelete.length,
    cleared_aps_docs: isAps,
  });
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
      .select("id, deal_id, is_shared, assignee, task_template_id, title")
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
    if (body.milestone_id !== undefined) updates.milestone_id = body.milestone_id;
    if (typeof body.title === "string") {
      const trimmed = body.title.trim();
      if (!trimmed) {
        return NextResponse.json(
          { success: false, error: "Title cannot be empty" },
          { status: 400 },
        );
      }
      updates.title = trimmed;
    }

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

      // Also sync to ALL other family deals' shared tasks. Matches by
      // task_template_id AND (for non-APS) by case-insensitive title so the
      // mirror crosses sides on a Purchase & Sale family — a co-seller's
      // Sale-side "Status of Mortgage" stays in lockstep with the
      // Purchase-side row on the primary even though their template ids
      // differ. APS keeps its existing side-scoped behaviour.
      let mirroredCount = 0;
      try {
        const familyDealIds = await getFamilyDealIds(primaryDealId);

        let isApsTask = false;
        if (existingTask.task_template_id) {
          const { data: tmpl } = await supabase
            .from("task_templates")
            .select("is_aps_task")
            .eq("id", existingTask.task_template_id)
            .maybeSingle();
          isApsTask = Boolean(tmpl?.is_aps_task);
        }

        const peerIds = await findFamilySharedTaskPeers({
          sourceTaskId: existingTask.id,
          dealId: primaryDealId,
          taskTemplateId: existingTask.task_template_id,
          title: existingTask.title ?? null,
          isApsTask,
        });

        if (peerIds.length > 0) {
          const { data: mirrored } = await supabase
            .from("tasks")
            .update(updates)
            .in("id", peerIds)
            .select("id");
          mirroredCount = mirrored?.length ?? 0;
        }

        // Recalculate milestone status for ALL family deals
        // When a shared task changes, milestones on linked deals may need updating
        if (updates.status !== undefined || updates.completed !== undefined) {
          await recalcMilestonesForFamily(familyDealIds, primaryDealId);
        }
      } catch {
        // Non-blocking
      }

      return NextResponse.json({ success: true, data, mirrored: mirroredCount });
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

    // Personal-task milestone recalc: when admin flips status/completed on a
    // personal (non-shared) task, the linked milestone must roll up so the
    // client dashboard reflects the change. Shared tasks already handle this
    // earlier in the function via recalcMilestonesForFamily.
    if (updates.status !== undefined || updates.completed !== undefined) {
      try {
        const familyDealIds = await getFamilyDealIds(existingTask.deal_id);
        await recalcMilestonesForFamily(familyDealIds, existingTask.deal_id);
      } catch {
        // Non-blocking: milestone recalc failure shouldn't fail the task update
      }
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
      // Postgres unique-violation (23505) on tasks_deal_task_template_unique
      // means a row already exists for this (deal_id, task_template_id).
      // Surface a friendly message so the admin knows what to do — the raw
      // constraint name is useless to end users.
      const isDuplicate =
        (error as any).code === "23505" ||
        /duplicate key|tasks_deal_task_template_unique/i.test(error.message ?? "");
      if (isDuplicate) {
        return NextResponse.json(
          {
            success: false,
            error:
              "A task for this template already exists on this deal. If it isn't visible, it may still exist on a linked co-purchaser/co-seller deal — refresh the page and delete the existing one from the source deal first.",
            code: "DUPLICATE_TASK_TEMPLATE",
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
