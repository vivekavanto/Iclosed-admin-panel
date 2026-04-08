import supabaseAdmin from "./supabaseAdmin";

/**
 * Recalculates milestone statuses for all deals in a co-purchaser family.
 *
 * For each deal, it gathers shared tasks (from the primary deal) and personal
 * tasks, then derives each milestone's status:
 *   - "Completed" when ALL tasks under it are completed
 *   - "In Progress" when at least one task is in-progress or completed
 *   - "Pending" otherwise
 *
 * This is the same logic previously inlined in the tasks PATCH handler,
 * extracted so it can be reused by APS automation and any future callers.
 */
export async function recalcMilestonesForFamily(
  familyDealIds: string[],
  primaryDealId: string,
) {
  // Pre-fetch all family milestones to do the mapping
  const { data: familyMilestones } = await supabaseAdmin
    .from("milestones")
    .select("id, deal_id, stage_template_id")
    .in("deal_id", familyDealIds);

  const primaryMsMap = new Map<string, string>(); // milestone_id -> stage_template_id
  const dealMsMap = new Map<string, Map<string, string>>(); // deal_id -> Map(stage_template_id -> milestone_id)

  if (familyMilestones) {
    familyMilestones.forEach((m) => {
      if (m.deal_id === primaryDealId)
        primaryMsMap.set(m.id, m.stage_template_id);

      if (!dealMsMap.has(m.deal_id)) dealMsMap.set(m.deal_id, new Map());
      dealMsMap.get(m.deal_id)!.set(m.stage_template_id, m.id);
    });
  }

  // Pre-fetch shared tasks from primaryDealId
  const { data: sharedTasks } = await supabaseAdmin
    .from("tasks")
    .select("milestone_id, status")
    .eq("deal_id", primaryDealId)
    .eq("is_shared", true)
    .not("milestone_id", "is", null);

  for (const famDealId of familyDealIds) {
    try {
      const { data: personalTasks } = await supabaseAdmin
        .from("tasks")
        .select("milestone_id, status")
        .eq("deal_id", famDealId)
        .or("is_shared.is.null,is_shared.eq.false")
        .not("milestone_id", "is", null);

      const localMsMap = dealMsMap.get(famDealId) || new Map();
      const milestoneTaskMap = new Map<string, string[]>();

      if (sharedTasks) {
        for (const t of sharedTasks) {
          let mappedMsId = t.milestone_id;
          if (famDealId !== primaryDealId) {
            const templId = primaryMsMap.get(t.milestone_id);
            if (templId && localMsMap.has(templId)) {
              mappedMsId = localMsMap.get(templId)!;
            } else {
              continue;
            }
          }
          if (!mappedMsId) continue;
          const arr = milestoneTaskMap.get(mappedMsId) ?? [];
          arr.push(t.status);
          milestoneTaskMap.set(mappedMsId, arr);
        }
      }

      if (personalTasks) {
        for (const t of personalTasks) {
          if (!t.milestone_id) continue;
          const arr = milestoneTaskMap.get(t.milestone_id) ?? [];
          arr.push(t.status);
          milestoneTaskMap.set(t.milestone_id, arr);
        }
      }

      const validLocalMilestones = new Set(localMsMap.values());

      for (const [msId, statuses] of milestoneTaskMap.entries()) {
        if (!validLocalMilestones.has(msId)) continue;

        const allDone =
          statuses.length > 0 && statuses.every((s) => s === "Completed");
        const anyActive = statuses.some(
          (s) => s === "In Progress" || s === "Completed",
        );
        const newStatus = allDone
          ? "Completed"
          : anyActive
            ? "In Progress"
            : "Pending";

        const msUpdates: Record<string, any> = {
          status: newStatus,
          completed_at: allDone ? new Date().toISOString() : null,
        };
        if (!allDone) {
          msUpdates.email_sent = false;
        }

        await supabaseAdmin
          .from("milestones")
          .update(msUpdates)
          .eq("id", msId);
      }
    } catch {
      // Non-blocking per deal
    }
  }
}
