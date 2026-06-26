import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { findFamilySharedTaskPeers } from "@/lib/findFamilySharedTaskPeers";
import { maybeCompleteFileTask } from "@/lib/maybeCompleteFileTask";

type TaskRow = {
  id: string;
  deal_id: string;
  title: string | null;
  is_shared: boolean | null;
  task_template_id: string | null;
};

type TaskResponseRow = {
  id: string;
  task_id: string;
  file_name: string | null;
  file_url: string | null;
  field_type: string | null;
  field_label: string | null;
  field_id: string | null;
  value: string | null;
};

function normalizeDocValue(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function getDocumentIdentity(
  response: Pick<TaskResponseRow, "id" | "task_id" | "file_name" | "file_url" | "field_label" | "field_id" | "value">,
) {
  const urlKey = normalizeDocValue(response.file_url);
  if (urlKey) return `url:${urlKey}`;

  const fileNameKey = normalizeDocValue(response.file_name);
  const fieldLabelKey = normalizeDocValue(response.field_label ?? response.field_id);
  const valueKey = normalizeDocValue(response.value);
  const fallbackKey = [fileNameKey, fieldLabelKey, valueKey].filter(Boolean).join("|");

  return fallbackKey ? `meta:${fallbackKey}` : `response:${response.id ?? response.task_id}`;
}

/**
 * For a shared task, finds all task IDs with the same task_template_id
 * across all deals in the co-purchaser family.
 */
async function getSharedTaskIds(taskId: string): Promise<string[]> {
  const { data: task } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, is_shared, task_template_id, title")
    .eq("id", taskId)
    .single();

  if (!task?.is_shared || !task?.task_template_id) return [taskId];

  const familyDealIds = await getFamilyDealIds(task.deal_id);

  // APS keeps its template-id-only scope. Other shared tasks also include
  // title-equivalent siblings so Purchase ↔ Sale rows in a P&S family stay
  // linked even though their templates have different ids.
  const { data: tmpl } = await supabaseAdmin
    .from("task_templates")
    .select("is_aps_task")
    .eq("id", task.task_template_id)
    .maybeSingle();
  const isApsTask = Boolean(tmpl?.is_aps_task);

  const ids = new Set<string>([taskId]);

  const { data: byTemplate } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("task_template_id", task.task_template_id)
    .eq("is_shared", true)
    .in("deal_id", familyDealIds);
  for (const t of byTemplate ?? []) ids.add(t.id);

  const trimmedTitle = task.title?.trim();
  if (!isApsTask && trimmedTitle) {
    const { data: byTitle } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .ilike("title", trimmedTitle)
      .eq("is_shared", true)
      .in("deal_id", familyDealIds);
    for (const t of byTitle ?? []) ids.add(t.id);
  }

  return [...ids];
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");
  const taskId = searchParams.get("task_id");
  // By default the deal-scoped query returns only file responses (the View
  // Documents modal / Doc-count column). `fields=all` lifts that filter so the
  // PDF export can also pull the text (personal-info) responses for every task.
  const includeAllFields = searchParams.get("fields") === "all";

  if (taskId) {
    try {
      const allTaskIds = await getSharedTaskIds(taskId);
      const { data: taskRows } = await supabaseAdmin
        .from("tasks")
        .select("id, deal_id, is_shared, task_template_id")
        .in("id", allTaskIds);

      const taskMap = new Map((taskRows ?? []).map((task) => [task.id, task]));
      const sourceTask = taskMap.get(taskId);

      const { data, error } = await supabaseAdmin
        .from("task_responses")
        .select("id, task_id, file_name, file_url, field_type, field_label, field_id, value")
        .in("task_id", allTaskIds);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Resolve missing file URLs from lead_corporate_docs
      const hasNullUrls = (data ?? []).some((item) => item.field_type === "file" && !item.file_url && item.file_name);
      if (hasNullUrls && sourceTask?.deal_id) {
        const { data: dealRow } = await supabaseAdmin
          .from("deals")
          .select("lead_id")
          .eq("id", sourceTask.deal_id)
          .single();

        if (dealRow?.lead_id) {
          // Get lead_corporate_docs from all family leads (for shared tasks)
          const leadIds = new Set<string>();
          for (const task of taskRows ?? []) {
            const { data: d } = await supabaseAdmin.from("deals").select("lead_id").eq("id", task.deal_id).single();
            if (d?.lead_id) leadIds.add(d.lead_id);
          }

          const { data: docs } = await supabaseAdmin
            .from("lead_corporate_docs")
            .select("file_name, file_url")
            .in("lead_id", [...leadIds]);

          if (docs?.length) {
            const docMap = new Map(docs.map((doc) => [doc.file_name, doc.file_url]));
            for (const item of data ?? []) {
              if (!item.file_url && item.file_name) {
                item.file_url = docMap.get(item.file_name) ?? null;
              }
            }
          }
        }
      }

      if (!sourceTask?.is_shared || !sourceTask.task_template_id) {
        return NextResponse.json(data ?? []);
      }

      const seen = new Set<string>();
      const deduped = (data ?? []).filter((response: TaskResponseRow) => {
        const taskMeta = taskMap.get(response.task_id);
        const sharedTaskKey = taskMeta?.task_template_id ?? sourceTask.task_template_id;
        const dedupeKey = `${sharedTaskKey}|${getDocumentIdentity(response)}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      });

      return NextResponse.json(deduped);
    } catch {
      const { data, error } = await supabaseAdmin
        .from("task_responses")
        .select("*")
        .eq("task_id", taskId);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      return NextResponse.json(data ?? []);
    }
  }

  if (!dealId) {
    return NextResponse.json({ error: "deal_id or task_id is required" }, { status: 400 });
  }

  // Resolve the primary deal in the family. Shared tasks are stored on
  // the primary deal as the single source of truth (per /api/admin/tasks)
  // — the doc-count column on the deal detail page renders task.id from
  // the primary, so we need to rewrite synced doc rows to match that id
  // (otherwise the count stays empty on co-purchaser/co-seller views).
  let primaryDealId = dealId;
  try {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();
    if (deal?.lead_id) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("id, parent_lead_id")
        .eq("id", deal.lead_id)
        .single();
      const rootLeadId = lead?.parent_lead_id ?? lead?.id;
      if (rootLeadId) {
        const { data: rootDeal } = await supabaseAdmin
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

  const { data: dealTasks, error: tasksError } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, title, is_shared, task_template_id")
    .eq("deal_id", dealId);

  if (tasksError) {
    return NextResponse.json([]);
  }

  // Always scan the whole family for shared tasks — even if the current
  // (e.g. co-purchaser/co-seller) deal has no local mirror row for a shared
  // task, the primary's task_responses still need to surface in the Doc
  // column. The previous behaviour gated the family lookup on the local
  // deal having shared task rows, which caused APS docs to silently
  // disappear from co-purchaser views when their mirror row was missing.
  const localTasks = dealTasks ?? [];
  const personalTaskIds = localTasks.filter((task) => !task.is_shared).map((task) => task.id);
  const localSharedTasks = localTasks.filter((task) => task.is_shared && task.task_template_id);
  const familyDealIds = await getFamilyDealIds(dealId);

  // Pull every shared task across the family so we can surface primary
  // task_responses on co-* views regardless of local mirror state.
  const { data: familySharedTasksData } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, title, is_shared, task_template_id")
    .eq("is_shared", true)
    .in("deal_id", familyDealIds);

  const familySharedTasks: TaskRow[] = (familySharedTasksData ?? []) as TaskRow[];
  const primarySharedTasks: TaskRow[] = familySharedTasks.filter((t) => t.deal_id === primaryDealId);

  // Backwards-compatible alias: downstream logic still refers to
  // `sharedTasks` as the set of shared tasks visible on the current deal.
  // Prefer local rows; if absent, fall back to primary's so titles &
  // template ids are still resolvable.
  const sharedTasks: TaskRow[] = localSharedTasks.length > 0
    ? localSharedTasks
    : primarySharedTasks;

  if (!localTasks.length && familySharedTasks.length === 0) {
    return NextResponse.json([]);
  }

  // Family-wide shared docs are surfaced for APS only. Other tasks that
  // happen to be is_shared (e.g. per-person Identification / Home Insurance)
  // must stay scoped to the CURRENT deal — otherwise the primary's View
  // Documents would list every co-purchaser/co-seller's personal documents.
  // The current deal's own shared tasks (`sharedTasks`) and personal tasks
  // (`personalTaskIds`) are still included unconditionally below.
  const { data: apsTemplatesData } = await supabaseAdmin
    .from("task_templates")
    .select("id")
    .eq("is_aps_task", true);
  const apsTemplateIds = new Set((apsTemplatesData ?? []).map((t) => t.id));
  const allSharedTaskIds = familySharedTasks
    .filter((task) => task.task_template_id && apsTemplateIds.has(task.task_template_id))
    .map((task) => task.id);
  // Query scope:
  //   - personalTaskIds        → the current deal's own personal docs
  //   - localSharedTasks       → the current deal's own shared docs
  //   - allSharedTaskIds (APS) → the family-wide APS doc only
  // Deliberately NOT the primary-fallback `sharedTasks` set: on a co-* deal
  // that would pull the primary's non-APS shared docs onto the co-*'s view.
  const allTaskIds = [...new Set([
    ...personalTaskIds,
    ...localSharedTasks.map((task) => task.id),
    ...allSharedTaskIds,
  ])];

  const localTaskById = new Map(localTasks.map((task) => [task.id, task]));
  const sharedTaskById = new Map(familySharedTasks.map((task) => [task.id, task]));
  const taskTitleById = new Map(localTasks.map((task) => [task.id, task.title ?? "Unknown Task"]));

  if (sharedTasks.length > 0) {
    const templateToTitle = new Map(
      sharedTasks
        .filter((task): task is TaskRow & { task_template_id: string } => Boolean(task.task_template_id))
        .map((task) => [task.task_template_id, task.title ?? "Unknown Task"]),
    );

    for (const task of familySharedTasks) {
      if (task.task_template_id && !taskTitleById.has(task.id)) {
        taskTitleById.set(task.id, templateToTitle.get(task.task_template_id) ?? "Unknown Task");
      }
    }
  }

  let responsesQuery = supabaseAdmin
    .from("task_responses")
    .select("id, task_id, file_name, file_url, field_type, field_label, field_id, value")
    .in("task_id", allTaskIds);
  if (!includeAllFields) {
    responsesQuery = responsesQuery.eq("field_type", "file");
  }
  const { data, error } = await responsesQuery;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const hasNullUrls = (data ?? []).some((item) => !item.file_url);
  if (hasNullUrls) {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (deal?.lead_id) {
      const { data: docs } = await supabaseAdmin
        .from("lead_corporate_docs")
        .select("file_name, file_url")
        .eq("lead_id", deal.lead_id);

      if (docs?.length) {
        const docMap = new Map(docs.map((doc) => [doc.file_name, doc.file_url]));
        for (const item of data ?? []) {
          if (!item.file_url && item.file_name) {
            item.file_url = docMap.get(item.file_name) ?? null;
          }
        }
      }
    }
  }

  // Map every shared template_id to the PRIMARY deal's task.id. The
  // tasks GET handler returns shared tasks from the primary as the
  // single source of truth, so the deal-detail page's Doc column
  // filters `taskFileDocs.filter(d => d.task_id === task.id)` against
  // primary task ids. Rewriting synced doc rows to the primary's task
  // id keeps the count correct on every family deal's view —
  // previously a co-purchaser/co-seller saw zero in the Doc column
  // because the rewrite pointed at their own local task id while the
  // displayed `task.id` was the primary's.
  const templateToPrimaryTaskId = new Map<string, string>();
  for (const task of primarySharedTasks) {
    if (task.task_template_id) {
      templateToPrimaryTaskId.set(task.task_template_id, task.id);
    }
  }
  // Fallback: if the primary deal didn't yet have the shared task
  // (e.g. mid-seed race), use the current deal's local id so the count
  // is at least never wrong on the primary itself.
  if (sharedTasks.length > 0 && templateToPrimaryTaskId.size === 0) {
    for (const task of sharedTasks) {
      if (task.task_template_id) {
        templateToPrimaryTaskId.set(task.task_template_id, task.id);
      }
    }
  }

  const familyTaskIdToTemplate = new Map<string, string>();
  for (const task of familySharedTasks) {
    if (task.task_template_id) {
      familyTaskIdToTemplate.set(task.id, task.task_template_id);
    }
  }

  // ── Diagnostic: trace the synced-doc rewrite to help debug why a
  // co-purchaser/co-seller view might not be showing the Doc count.
  // Safe to remove once verified.
  console.log("[task-responses GET]", {
    requested_deal_id: dealId,
    primary_deal_id: primaryDealId,
    is_viewing_primary: dealId === primaryDealId,
    family_deal_ids: familyDealIds,
    deal_tasks_count: dealTasks.length,
    shared_task_ids_local: sharedTasks.map(t => t.id),
    family_shared_task_ids: familySharedTasks.map(t => `${t.id} (deal:${t.deal_id})`),
    primary_shared_task_ids: primarySharedTasks.map(t => `${t.id} (template:${t.task_template_id})`),
    template_to_primary_map: Array.from(templateToPrimaryTaskId.entries()),
    raw_responses_count: data?.length ?? 0,
    raw_response_task_ids: (data ?? []).map(r => r.task_id),
  });

  const result = (data ?? []).map((response: TaskResponseRow) => {
    const taskMeta = sharedTaskById.get(response.task_id) ?? localTaskById.get(response.task_id);
    const templateId = familyTaskIdToTemplate.get(response.task_id) ?? taskMeta?.task_template_id ?? null;
    const isSharedDocument = Boolean(taskMeta?.is_shared && templateId);

    let effectiveTaskId = response.task_id;
    let title = taskTitleById.get(response.task_id) ?? "Unknown Task";

    if (isSharedDocument && templateId && templateToPrimaryTaskId.has(templateId)) {
      effectiveTaskId = templateToPrimaryTaskId.get(templateId)!;
      title =
        taskTitleById.get(effectiveTaskId) ??
        sharedTasks.find((task) => task.task_template_id === templateId)?.title ??
        title;
    }

    // Diagnostic per-row
    console.log("[task-responses GET → row]", {
      original_task_id: response.task_id,
      effective_task_id: effectiveTaskId,
      template_id: templateId,
      is_shared_document: isSharedDocument,
      file_name: response.file_name,
      rewrote: response.task_id !== effectiveTaskId,
    });

    return {
      ...response,
      response_id: response.id,
      is_shared: isSharedDocument,
      shared_task_key: isSharedDocument ? templateId ?? effectiveTaskId : null,
      // Source template id for the owning task (shared OR personal). Lets the
      // client resolve which lead type (Purchase / Sale) the document belongs
      // to, so every doc — not just APS — can be tagged with its side.
      task_template_id: templateId,
      task_id: effectiveTaskId,
      task_title: title,
    };
  });

  const seenDocs = new Set<string>();
  const dedupedResult = result.filter((doc) => {
    if (!doc.is_shared) return true;

    const dedupeKey = `${doc.shared_task_key ?? doc.task_id}|${getDocumentIdentity(doc)}`;
    if (seenDocs.has(dedupeKey)) return false;
    seenDocs.add(dedupeKey);
    return true;
  });

  return NextResponse.json(dedupedResult);
}

/**
 * PATCH /api/admin/task-responses
 * Body: { id: string, value?: string, file_url?: string, file_name?: string }
 *
 * Admin override for a client-submitted response. Supports both textual
 * `value` edits and file replacement (file_url + file_name).
 *
 * For file replacements on a shared task (is_shared=true with a
 * task_template_id), the new file is mirrored to every matching response
 * across the co-purchaser/co-seller family — same task_template_id, same
 * field (matched by field_id, fallback field_label). APS uploads have
 * their own dedicated flow at /uploadblobstorage and don't go through
 * here.
 */
export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const { id, value, file_url, file_name } = body as {
      id?: string;
      value?: string | null;
      file_url?: string | null;
      file_name?: string | null;
    };
    if (!id) {
      return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
    }
    const updates: Record<string, any> = {};
    if (value !== undefined) updates.value = value === "" ? null : value;
    if (file_url !== undefined) updates.file_url = file_url || null;
    if (file_name !== undefined) updates.file_name = file_name || null;
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ success: false, error: "Nothing to update" }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("task_responses")
      .update(updates)
      .eq("id", id)
      .select("id, task_id, field_id, field_label, field_type, file_url, file_name, value")
      .single();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Family-wide mirror for shared-task file replacements. Only kicks in
    // when this PATCH actually changed file_url/file_name — pure text edits
    // stay scoped to the single row.
    const isFileReplace = file_url !== undefined || file_name !== undefined;
    let mirroredCount = 0;
    if (isFileReplace && data) {
      const { data: srcTask } = await supabaseAdmin
        .from("tasks")
        .select("id, deal_id, is_shared, task_template_id, title")
        .eq("id", data.task_id)
        .single();

      if (srcTask?.is_shared && srcTask.task_template_id && srcTask.deal_id) {
        const { data: tmpl } = await supabaseAdmin
          .from("task_templates")
          .select("is_aps_task")
          .eq("id", srcTask.task_template_id)
          .maybeSingle();
        const isApsTask = Boolean(tmpl?.is_aps_task);

        const peers = await findFamilySharedTaskPeers({
          sourceTaskId: srcTask.id,
          dealId: srcTask.deal_id,
          taskTemplateId: srcTask.task_template_id,
          title: srcTask.title ?? null,
          isApsTask,
        });
        const peerTaskIds = peers;

        if (peerTaskIds.length > 0) {
          // Match peer responses by field_id (canonical) or field_label
          // (fallback when field_id is null on older rows).
          let peerQuery = supabaseAdmin
            .from("task_responses")
            .update(updates)
            .in("task_id", peerTaskIds)
            .eq("field_type", "file");

          if (data.field_id) {
            peerQuery = peerQuery.eq("field_id", data.field_id);
          } else if (data.field_label) {
            peerQuery = peerQuery.eq("field_label", data.field_label);
          }

          const { data: mirrored, error: mirrorError } = await peerQuery.select("id");
          if (mirrorError) {
            // Don't fail the primary update — surface as a soft warning.
            return NextResponse.json({
              success: true,
              data,
              mirrored: 0,
              mirror_warning: mirrorError.message,
            });
          }
          mirroredCount = mirrored?.length ?? 0;
        }
      }
    }

    // Auto-complete file-only tasks (ID, Home Insurance, etc.) once all
    // required file fields are filled — parity with the APS upload flow.
    let taskCompleted = false;
    if (isFileReplace && data?.task_id) {
      try {
        const result = await maybeCompleteFileTask(data.task_id);
        taskCompleted = result.completed;
      } catch (err) {
        console.error("[task-responses PATCH] auto-complete failed:", err);
      }
    }

    return NextResponse.json({
      success: true,
      data,
      mirrored: mirroredCount,
      task_completed: taskCompleted,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "Server error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/task-responses
 * Body: { task_id, field_id, field_label, field_type, value?, file_url?, file_name? }
 *
 * Creates a new admin-entered response for a form field that the client
 * left blank. Supports both text values and file uploads (file_url +
 * file_name for `field_type=file`). For shared tasks the row is
 * mirrored across the co-purchaser/co-seller family so every linked
 * deal sees the same admin override.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      task_id,
      field_id,
      field_label,
      field_type,
      value,
      file_url,
      file_name,
    } = body as {
      task_id?: string;
      field_id?: string | null;
      field_label?: string | null;
      field_type?: string | null;
      value?: string | null;
      file_url?: string | null;
      file_name?: string | null;
    };
    if (!task_id) {
      return NextResponse.json({ success: false, error: "task_id is required" }, { status: 400 });
    }
    if (!field_label || !field_type) {
      return NextResponse.json(
        { success: false, error: "field_label and field_type are required" },
        { status: 400 },
      );
    }

    const insertRow = {
      task_id,
      field_id: field_id ?? null,
      field_label,
      field_type,
      value: value === "" ? null : value ?? null,
      file_url: file_url || null,
      file_name: file_name || null,
    };

    const { data, error } = await supabaseAdmin
      .from("task_responses")
      .insert(insertRow)
      .select("id, task_id, field_id, field_label, field_type, value, file_url, file_name")
      .single();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Family-wide mirror for shared-task responses — same matching as PATCH
    // (skip the source task; match peers by field_id or field_label).
    let mirroredCount = 0;
    const { data: srcTask } = await supabaseAdmin
      .from("tasks")
      .select("id, deal_id, is_shared, task_template_id, title")
      .eq("id", task_id)
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
        const peerRows = peerTaskIds.map((tid) => ({
          task_id: tid,
          field_id: insertRow.field_id,
          field_label: insertRow.field_label,
          field_type: insertRow.field_type,
          value: insertRow.value,
          file_url: insertRow.file_url,
          file_name: insertRow.file_name,
        }));
        const { data: mirrored } = await supabaseAdmin
          .from("task_responses")
          .insert(peerRows)
          .select("id");
        mirroredCount = mirrored?.length ?? 0;
      }
    }

    // Auto-complete file-only tasks once all required files are present.
    let taskCompleted = false;
    if (field_type === "file" && file_url) {
      try {
        const result = await maybeCompleteFileTask(task_id);
        taskCompleted = result.completed;
      } catch (err) {
        console.error("[task-responses POST] auto-complete failed:", err);
      }
    }

    return NextResponse.json({
      success: true,
      data,
      mirrored: mirroredCount,
      task_completed: taskCompleted,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "Server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/task-responses?id=...
 *
 * Removes a single client-submitted response row. Blob bytes (if it was a
 * file upload) are left in Vercel Blob — matching how lead_corporate_docs
 * deletions are handled elsewhere in this codebase.
 */
export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
  }
  const { error } = await supabaseAdmin
    .from("task_responses")
    .delete()
    .eq("id", id);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ success: true });
}
