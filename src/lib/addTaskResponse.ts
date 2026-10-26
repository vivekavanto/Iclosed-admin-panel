import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { findFamilySharedTaskPeers } from "./findFamilySharedTaskPeers";
import { maybeCompleteFileTask } from "./maybeCompleteFileTask";

export type TaskResponseInsert = {
  task_id: string;
  field_id: string | null;
  field_label: string;
  field_type: string;
  value: string | null;
  file_url: string | null;
  file_name: string | null;
};

export class TaskResponseInsertError extends Error {}

/** Inserts a task response, mirrors it to shared-task peers and completes file tasks once full. */
export async function addTaskResponse(insertRow: TaskResponseInsert) {
  const { data, error } = await supabaseAdmin
    .from("task_responses")
    .insert(insertRow)
    .select("id, task_id, field_id, field_label, field_type, value, file_url, file_name")
    .single();
  if (error) throw new TaskResponseInsertError(error.message);

  // Family-wide mirror for shared-task responses — same matching as PATCH
  // (skip the source task; match peers by field_id or field_label).
  let mirroredCount = 0;
  const { data: srcTask } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, is_shared, task_template_id, title")
    .eq("id", insertRow.task_id)
    .single();
  if (srcTask?.is_shared && srcTask.task_template_id && srcTask.deal_id) {
    const { data: tmpl } = await supabaseAdmin
      .from("task_templates")
      .select("is_aps_task")
      .eq("id", srcTask.task_template_id)
      .maybeSingle();
    const isApsTask = Boolean(tmpl?.is_aps_task);

    const peerTaskIds = await findFamilySharedTaskPeers({
      sourceTaskId: srcTask.id,
      dealId: srcTask.deal_id,
      taskTemplateId: srcTask.task_template_id,
      title: srcTask.title ?? null,
      isApsTask,
    });
    if (peerTaskIds.length > 0) {
      // GAP-004: skip peers already holding this response, so a retry can't duplicate it.
      // Deduped in code because a file field may hold several files.
      const matchCol = insertRow.file_url ? "file_url" : "value";
      const matchVal = insertRow.file_url ?? insertRow.value ?? null;
      let alreadyHave = new Set<string>();
      if (matchVal != null && insertRow.field_id != null) {
        const { data: existing } = await supabaseAdmin
          .from("task_responses")
          .select("task_id")
          .in("task_id", peerTaskIds)
          .eq("field_id", insertRow.field_id)
          .eq(matchCol, matchVal);
        alreadyHave = new Set(
          (existing ?? []).map((r) => r.task_id as string),
        );
      }
      const peerRows = peerTaskIds
        .filter((tid) => !alreadyHave.has(tid))
        .map((tid) => ({
          task_id: tid,
          field_id: insertRow.field_id,
          field_label: insertRow.field_label,
          field_type: insertRow.field_type,
          value: insertRow.value,
          file_url: insertRow.file_url,
          file_name: insertRow.file_name,
        }));
      if (peerRows.length > 0) {
        const { data: mirrored } = await supabaseAdmin
          .from("task_responses")
          .insert(peerRows)
          .select("id");
        mirroredCount = mirrored?.length ?? 0;
      }
    }
  }

  // Auto-complete file-only tasks once all required files are present.
  let taskCompleted = false;
  if (insertRow.field_type === "file" && insertRow.file_url) {
    try {
      const result = await maybeCompleteFileTask(insertRow.task_id);
      taskCompleted = result.completed;
    } catch (err) {
      logger.error("[addTaskResponse] auto-complete failed:", err);
    }
  }

  return { data, mirrored: mirroredCount, taskCompleted };
}
