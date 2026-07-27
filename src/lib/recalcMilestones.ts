import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

/**
 * Recalculates milestone statuses for a co-purchaser/co-seller family, treating
 * each milestone as COMMON across the family: the per-person personal tasks
 * (ID, Personal Information, ...) plus the primary deal's shared tasks are
 * POOLED by `stage_template_id`, and the resulting status is written to every
 * per-deal instance of that stage.
 *
 *   - "Completed" only when ALL pooled tasks (every person's) are completed
 *   - "Pending" otherwise
 *
 * We pool by `stage_template_id` (not `milestone_id`) because each deal owns its
 * own milestone row for the same stage; that template id is the stable
 * family-wide key already used by the tasks GET route and the email route.
 *
 * When a stage transitions to Completed, the milestone email is fired EXACTLY
 * ONCE for the whole family (off the primary deal's instance, with
 * sendToLinkedDeals) so every client is notified and `email_sent` is marked
 * family-wide. Reopening a stage (away from Completed — e.g. a co-person added
 * after completion) clears `email_sent` so the email can re-fire once everyone
 * finishes again.
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

  // Fetch all family milestones once and build the stage→instances mapping.
  const { data: familyMilestones } = await supabaseAdmin
    .from("milestones")
    .select("id, deal_id, stage_template_id, status, email_template_id, email_sent")
    .in("deal_id", familyDealIds)
    .eq("is_deleted", false);

  type MsInstance = {
    id: string;
    deal_id: string;
    status: string;
    email_template_id: string | null;
    email_sent: boolean;
  };
  const msToStage = new Map<string, string>(); // milestone_id -> stage_template_id
  const stageToInstances = new Map<string, MsInstance[]>(); // stage_template_id -> per-deal rows

  (familyMilestones ?? []).forEach((m) => {
    if (!m.stage_template_id) return; // can't pool a milestone with no stage key
    msToStage.set(m.id, m.stage_template_id);
    const arr = stageToInstances.get(m.stage_template_id) ?? [];
    arr.push({
      id: m.id,
      deal_id: m.deal_id,
      status: m.status,
      email_template_id: m.email_template_id,
      email_sent: m.email_sent ?? false,
    });
    stageToInstances.set(m.stage_template_id, arr);
  });

  // Shared tasks live once on the primary deal; personal tasks live one-per-
  // person across the family. Pool BOTH by stage.
  const [{ data: sharedTasks }, { data: personalTasks }] = await Promise.all([
    supabaseAdmin
      .from("tasks")
      .select("milestone_id, status")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .eq("is_deleted", false)
      .not("milestone_id", "is", null),
    supabaseAdmin
      .from("tasks")
      .select("milestone_id, status")
      .in("deal_id", familyDealIds)
      .or("is_shared.is.null,is_shared.eq.false")
      .eq("is_deleted", false)
      .not("milestone_id", "is", null),
  ]);

  // stage_template_id -> pooled task statuses across the whole family
  const stageStatuses = new Map<string, string[]>();
  const poolStatus = (milestoneId: string | null, status: string) => {
    if (!milestoneId) return;
    const stage = msToStage.get(milestoneId);
    if (!stage) return;
    const arr = stageStatuses.get(stage) ?? [];
    arr.push(status);
    stageStatuses.set(stage, arr);
  };
  (sharedTasks ?? []).forEach((t) => poolStatus(t.milestone_id, t.status));
  (personalTasks ?? []).forEach((t) => poolStatus(t.milestone_id, t.status));

  // For each stage that actually has tasks, derive ONE status and write it to
  // every per-deal instance. Stages with no tasks are left untouched so manual
  // / date-only milestones aren't clobbered (matches the prior per-deal logic,
  // which only ever updated milestones that had at least one task).
  for (const [stage, instances] of stageToInstances.entries()) {
    const statuses = stageStatuses.get(stage) ?? [];
    if (statuses.length === 0) continue;

    const allDone = statuses.every((s) => s === "Completed");
    const newStatus = allDone ? "Completed" : "Pending";

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
      .in(
        "id",
        instances.map((m) => m.id),
      );

    // Fire the completion email once for the whole family, off the primary
    // deal's instance. Guards on the PRE-UPDATE snapshot so it fires only on a
    // genuine transition into Completed and never twice.
    if (allDone && sendEmails) {
      const primaryInstance =
        instances.find((m) => m.deal_id === primaryDealId) ?? instances[0];
      if (
        primaryInstance &&
        primaryInstance.status !== "Completed" && // was NOT already completed
        primaryInstance.email_template_id && // has an email template linked
        !primaryInstance.email_sent // email not already sent
      ) {
        try {
          const baseUrl = process.env.VERCEL_URL
            ? `https://${process.env.VERCEL_URL}`
            : "http://localhost:3000";
          const res = await fetch(`${baseUrl}/api/admin/send-milestone-email`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              milestoneId: primaryInstance.id,
              dealId: primaryDealId,
              sendToLinkedDeals: true,
            }),
          });
          // GAP-014: fetch only throws on a network error, so a 4xx/5xx from the
          // email route would otherwise be swallowed. Surface it (non-blocking).
          if (!res.ok) {
            logger.warn(
              `[recalcMilestones] milestone email returned HTTP ${res.status} — milestone=${primaryInstance.id} deal=${primaryDealId}`,
            );
          }
        } catch (err) {
          // Non-blocking — a send failure must not break recalc — but GAP-014:
          // log it with IDs so a family silently missing its email is visible.
          logger.warn(
            `[recalcMilestones] milestone email failed — milestone=${primaryInstance.id} deal=${primaryDealId}:`,
            err,
          );
        }
      }
    }
  }
}
