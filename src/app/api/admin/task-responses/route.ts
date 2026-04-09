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
  field_name: string | null;
  value: string | null;
};

function normalizeDocValue(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function getDocumentIdentity(
  response: Pick<TaskResponseRow, "id" | "task_id" | "file_name" | "file_url" | "field_label" | "field_name" | "value">,
) {
  const urlKey = normalizeDocValue(response.file_url);
  if (urlKey) return `url:${urlKey}`;

  const fileNameKey = normalizeDocValue(response.file_name);
  const fieldLabelKey = normalizeDocValue(response.field_label ?? response.field_name);
  const valueKey = normalizeDocValue(response.value);
  const fallbackKey = [fileNameKey, fieldLabelKey, valueKey].filter(Boolean).join("|");

  return fallbackKey ? `meta:${fallbackKey}` : `response:${response.id ?? response.task_id}`;
}

async function resolvePrimaryDealId(dealId: string): Promise<string> {
  try {
    const { data: dealRow } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (!dealRow?.lead_id) return dealId;

    const { data: leadRow } = await supabaseAdmin
      .from("leads")
      .select("id, parent_lead_id")
      .eq("id", dealRow.lead_id)
      .single();

    const rootLeadId = leadRow?.parent_lead_id ?? leadRow?.id;
    if (!rootLeadId) return dealId;

    const { data: rootDeal } = await supabaseAdmin
      .from("deals")
      .select("id")
      .eq("lead_id", rootLeadId)
      .maybeSingle();

    return rootDeal?.id ?? dealId;
  } catch {
    return dealId;
  }
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
        .select("id, task_id, file_name, file_url, field_type, field_label, field_name, value")
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
  const primaryDealId = sharedTasks.length > 0 ? await resolvePrimaryDealId(dealId) : dealId;

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
    .select("id, task_id, file_name, file_url, field_type, field_label, field_name, value")
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

  const templateToPrimaryTaskId = new Map<string, string>();
  if (sharedTasks.length > 0) {
    const sharedTemplateIds = sharedTasks
      .map((task) => task.task_template_id)
      .filter((taskTemplateId): taskTemplateId is string => Boolean(taskTemplateId));

    if (primaryDealId !== dealId) {
      const { data: primaryTasks } = await supabaseAdmin
        .from("tasks")
        .select("id, task_template_id")
        .eq("deal_id", primaryDealId)
        .eq("is_shared", true)
        .in("task_template_id", sharedTemplateIds);

      for (const task of primaryTasks ?? []) {
        if (task.task_template_id) {
          templateToPrimaryTaskId.set(task.task_template_id, task.id);
        }
      }
    } else {
      for (const task of sharedTasks) {
        if (task.task_template_id) {
          templateToPrimaryTaskId.set(task.task_template_id, task.id);
        }
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

    if (isSharedDocument && templateId && templateToPrimaryTaskId.has(templateId)) {
      effectiveTaskId = templateToPrimaryTaskId.get(templateId)!;
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
