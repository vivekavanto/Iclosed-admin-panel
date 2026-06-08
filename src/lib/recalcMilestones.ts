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
  options: { sendEmails?: boolean } = {},
) {
  // Template-edit cascades (repointing task→milestone links, backfilling a new
  // milestone onto existing deals) should NOT fire client emails just because a
  // pre-completed task landed on a fresh milestone — only genuine task
  // completion flows should. Such callers opt out via { sendEmails: false }.
  const sendEmails = options.sendEmails ?? true;
  // Pre-fetch all family milestones to do the mapping
  const { data: familyMilestones } = await supabaseAdmin
    .from("milestones")
    .select("id, deal_id, stage_template_id, status, email_template_id, email_sent")
    .in("deal_id", familyDealIds)
    .eq("is_deleted", false);

  const primaryMsMap = new Map<string, string>(); // milestone_id -> stage_template_id
  const dealMsMap = new Map<string, Map<string, string>>(); // deal_id -> Map(stage_template_id -> milestone_id)
  const msMetaMap = new Map<string, { deal_id: string; status: string; email_template_id: string | null; email_sent: boolean }>(); // milestone_id -> metadata

  if (familyMilestones) {
    familyMilestones.forEach((m) => {
      if (m.deal_id === primaryDealId)
        primaryMsMap.set(m.id, m.stage_template_id);

      if (!dealMsMap.has(m.deal_id)) dealMsMap.set(m.deal_id, new Map());
      dealMsMap.get(m.deal_id)!.set(m.stage_template_id, m.id);

      msMetaMap.set(m.id, {
        deal_id: m.deal_id,
        status: m.status,
        email_template_id: m.email_template_id,
        email_sent: m.email_sent ?? false,
      });
    });
  }

  // Pre-fetch shared tasks from primaryDealId
  const { data: sharedTasks } = await supabaseAdmin
    .from("tasks")
    .select("milestone_id, status")
    .eq("deal_id", primaryDealId)
    .eq("is_shared", true)
    .eq("is_deleted", false)
    .not("milestone_id", "is", null);

  for (const famDealId of familyDealIds) {
    try {
      const { data: personalTasks } = await supabaseAdmin
        .from("tasks")
        .select("milestone_id, status")
        .eq("deal_id", famDealId)
        .or("is_shared.is.null,is_shared.eq.false")
        .eq("is_deleted", false)
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

        // Auto-send email when milestone transitions to Completed
        if (allDone && sendEmails) {
          const meta = msMetaMap.get(msId);
          if (
            meta &&
            meta.status !== "Completed" && // was NOT already completed
            meta.email_template_id &&       // has an email template linked
            !meta.email_sent                // email not already sent
          ) {
            try {
              const baseUrl = process.env.VERCEL_URL
                ? `https://${process.env.VERCEL_URL}`
                : "http://localhost:3000";
              await fetch(
                `${baseUrl}/api/admin/send-milestone-email`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    milestoneId: msId,
                    dealId: famDealId,
                    sendToLinkedDeals: true,
                  }),
                },
              );
            } catch {
              // Non-blocking — email send failure should not break recalc
            }
          }
        }
      }
    } catch {
      // Non-blocking per deal
    }
  }
}
