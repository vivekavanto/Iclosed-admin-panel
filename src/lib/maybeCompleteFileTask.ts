import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { recalcMilestonesForFamily } from "./recalcMilestones";

/**
 * If `taskId`'s template has required file fields and every one of them now
 * has a `task_responses` row with a `file_url`, mark the task Completed —
 * along with its shared peers across the co-purchaser/co-seller family —
 * and recalculate milestone statuses for the family.
 *
 * Generic counterpart to `completeApsTask` (which is APS-template-scoped),
 * used by the admin task-responses POST/PATCH endpoints so that uploading
 * the final required file on tasks like "Upload Identification" or
 * "Upload Home Insurance Policy" auto-advances the task + milestone, the
 * same way an APS upload does.
 *
 * Idempotent — returns `{ completed: false }` when the task is already
 * Completed or when any required file field is still missing.
 */
export async function maybeCompleteFileTask(
  taskId: string,
): Promise<{ completed: boolean }> {
  const { data: task } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, task_template_id, is_shared, status")
    .eq("id", taskId)
    .maybeSingle();

  if (!task || !task.task_template_id || !task.deal_id) {
    return { completed: false };
  }
  if (task.status === "Completed") {
    return { completed: false };
  }

  const { data: requiredFileFields } = await supabaseAdmin
    .from("task_form_fields")
    .select("id, label")
    .eq("task_template_id", task.task_template_id)
    .eq("field_type", "file")
    .eq("required", true);

  if (!requiredFileFields || requiredFileFields.length === 0) {
    return { completed: false };
  }

  const { data: responses } = await supabaseAdmin
    .from("task_responses")
    .select("field_id, field_label, file_url")
    .eq("task_id", taskId)
    .eq("field_type", "file");

  const filledByFieldId = new Set<string>();
  const filledByLabel = new Set<string>();
  for (const r of responses ?? []) {
    if (!r.file_url) continue;
    if (r.field_id) filledByFieldId.add(r.field_id);
    if (r.field_label) filledByLabel.add(r.field_label);
  }

  const allFilled = requiredFileFields.every(
    (f) => filledByFieldId.has(f.id) || filledByLabel.has(f.label),
  );
  if (!allFilled) {
    return { completed: false };
  }

  const now = new Date().toISOString();
  const completionPayload = {
    status: "Completed" as const,
    completed: true,
    completed_at: now,
  };

  await supabaseAdmin
    .from("tasks")
    .update(completionPayload)
    .eq("id", task.id);

  // Mirror completion to shared peers on the rest of the family.
  if (task.is_shared) {
    const familyDealIds = await getFamilyDealIds(task.deal_id);
    const otherDealIds = familyDealIds.filter((id) => id !== task.deal_id);
    if (otherDealIds.length > 0) {
      await supabaseAdmin
        .from("tasks")
        .update(completionPayload)
        .eq("task_template_id", task.task_template_id)
        .eq("is_shared", true)
        .in("deal_id", otherDealIds);
    }
    await recalcMilestonesForFamily(familyDealIds, task.deal_id);
  } else {
    await recalcMilestonesForFamily([task.deal_id], task.deal_id);
  }

  return { completed: true };
}
