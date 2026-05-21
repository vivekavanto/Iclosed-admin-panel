import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

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
    .select("id, deal_id, is_shared, task_template_id")
    .eq("id", taskId)
    .single();

  if (!task?.is_shared || !task?.task_template_id) return [taskId];

  const familyDealIds = await getFamilyDealIds(task.deal_id);

  const { data: familyTasks } = await supabaseAdmin
    .from("tasks")
    .select("id")
    .eq("task_template_id", task.task_template_id)
    .eq("is_shared", true)
    .in("deal_id", familyDealIds);

  if (!familyTasks) return [taskId];
  return familyTasks.map((t) => t.id);
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dealId = searchParams.get("deal_id");
  const taskId = searchParams.get("task_id");

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

  const { data: dealTasks, error: tasksError } = await supabaseAdmin
    .from("tasks")
    .select("id, deal_id, title, is_shared, task_template_id")
    .eq("deal_id", dealId);

  if (tasksError || !dealTasks?.length) {
    return NextResponse.json([]);
  }

  const personalTaskIds = dealTasks.filter((task) => !task.is_shared).map((task) => task.id);
  const sharedTasks = dealTasks.filter((task) => task.is_shared && task.task_template_id);
  const familyDealIds = sharedTasks.length > 0 ? await getFamilyDealIds(dealId) : [dealId];

  let familySharedTasks: TaskRow[] = [];
  if (sharedTasks.length > 0) {
    const sharedTemplateIds = sharedTasks
      .map((task) => task.task_template_id)
      .filter((taskTemplateId): taskTemplateId is string => Boolean(taskTemplateId));

    const { data } = await supabaseAdmin
      .from("tasks")
      .select("id, deal_id, title, is_shared, task_template_id")
      .eq("is_shared", true)
      .in("task_template_id", sharedTemplateIds)
      .in("deal_id", familyDealIds);

    familySharedTasks = (data ?? []) as TaskRow[];
  }

  const allSharedTaskIds = familySharedTasks.map((task) => task.id);
  const allTaskIds = [...new Set([...personalTaskIds, ...sharedTasks.map((task) => task.id), ...allSharedTaskIds])];

  const localTaskById = new Map(dealTasks.map((task) => [task.id, task]));
  const sharedTaskById = new Map(familySharedTasks.map((task) => [task.id, task]));
  const taskTitleById = new Map(dealTasks.map((task) => [task.id, task.title ?? "Unknown Task"]));

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

  const { data, error } = await supabaseAdmin
    .from("task_responses")
    .select("id, task_id, file_name, file_url, field_type, field_label, field_id, value")
    .in("task_id", allTaskIds)
    .eq("field_type", "file");

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

  // Map shared docs to the *local* deal's task (matched by task_template_id),
  // not the primary's. The doc-count column on the deal detail page filters
  // taskFileDocs by `d.task_id === task.id`, so for a co-purchaser/co-seller
  // page the rewritten id must point at that deal's own mirrored task or the
  // bridged APS doc never shows on their task row.
  const templateToLocalTaskId = new Map<string, string>();
  if (sharedTasks.length > 0) {
    for (const task of sharedTasks) {
      if (task.task_template_id) {
        templateToLocalTaskId.set(task.task_template_id, task.id);
      }
    }
  }

  const familyTaskIdToTemplate = new Map<string, string>();
  for (const task of familySharedTasks) {
    if (task.task_template_id) {
      familyTaskIdToTemplate.set(task.id, task.task_template_id);
    }
  }

  const result = (data ?? []).map((response: TaskResponseRow) => {
    const taskMeta = sharedTaskById.get(response.task_id) ?? localTaskById.get(response.task_id);
    const templateId = familyTaskIdToTemplate.get(response.task_id) ?? taskMeta?.task_template_id ?? null;
    const isSharedDocument = Boolean(taskMeta?.is_shared && templateId);

    let effectiveTaskId = response.task_id;
    let title = taskTitleById.get(response.task_id) ?? "Unknown Task";

    if (isSharedDocument && templateId && templateToLocalTaskId.has(templateId)) {
      effectiveTaskId = templateToLocalTaskId.get(templateId)!;
      title =
        taskTitleById.get(effectiveTaskId) ??
        sharedTasks.find((task) => task.task_template_id === templateId)?.title ??
        title;
    }

    return {
      ...response,
      response_id: response.id,
      is_shared: isSharedDocument,
      shared_task_key: isSharedDocument ? templateId ?? effectiveTaskId : null,
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
        .select("id, deal_id, is_shared, task_template_id")
        .eq("id", data.task_id)
        .single();

      if (srcTask?.is_shared && srcTask.task_template_id && srcTask.deal_id) {
        const familyDealIds = await getFamilyDealIds(srcTask.deal_id);

        const { data: familyTasks } = await supabaseAdmin
          .from("tasks")
          .select("id")
          .eq("is_shared", true)
          .eq("task_template_id", srcTask.task_template_id)
          .in("deal_id", familyDealIds);
        const familyTaskIds = (familyTasks ?? []).map((t) => t.id);
        const peerTaskIds = familyTaskIds.filter((tid) => tid !== data.task_id);

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

    return NextResponse.json({ success: true, data, mirrored: mirroredCount });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message ?? "Server error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/task-responses
 * Body: { task_id, field_id, field_label, field_type, value? }
 *
 * Creates a new admin-entered response for a form field that the client
 * left blank. For shared tasks the row is mirrored across the
 * co-purchaser/co-seller family so every linked deal sees the same
 * admin override.
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
    } = body as {
      task_id?: string;
      field_id?: string | null;
      field_label?: string | null;
      field_type?: string | null;
      value?: string | null;
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
    };

    const { data, error } = await supabaseAdmin
      .from("task_responses")
      .insert(insertRow)
      .select("id, task_id, field_id, field_label, field_type, value")
      .single();
    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    // Family-wide mirror for shared-task responses — same matching as PATCH
    // (skip the source task; match peers by field_id or field_label).
    let mirroredCount = 0;
    const { data: srcTask } = await supabaseAdmin
      .from("tasks")
      .select("id, deal_id, is_shared, task_template_id")
      .eq("id", task_id)
      .single();
    if (srcTask?.is_shared && srcTask.task_template_id && srcTask.deal_id) {
      const familyDealIds = await getFamilyDealIds(srcTask.deal_id);
      const { data: familyTasks } = await supabaseAdmin
        .from("tasks")
        .select("id")
        .eq("is_shared", true)
        .eq("task_template_id", srcTask.task_template_id)
        .in("deal_id", familyDealIds);
      const peerTaskIds = (familyTasks ?? [])
        .map((t) => t.id)
        .filter((tid) => tid !== task_id);
      if (peerTaskIds.length > 0) {
        const peerRows = peerTaskIds.map((tid) => ({
          task_id: tid,
          field_id: insertRow.field_id,
          field_label: insertRow.field_label,
          field_type: insertRow.field_type,
          value: insertRow.value,
        }));
        const { data: mirrored } = await supabaseAdmin
          .from("task_responses")
          .insert(peerRows)
          .select("id");
        mirroredCount = mirrored?.length ?? 0;
      }
    }

    return NextResponse.json({ success: true, data, mirrored: mirroredCount });
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
