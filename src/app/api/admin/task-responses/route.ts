import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";

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

  // ── By task_id: return responses for a specific task ─────────────────────
  // For shared tasks, also include responses from linked co-purchaser deal tasks
  if (taskId) {
    try {
      const allTaskIds = await getSharedTaskIds(taskId);

      const { data, error } = await supabaseAdmin
        .from("task_responses")
        .select("*")
        .in("task_id", allTaskIds);

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      // Deduplicate: shared tasks produce identical responses across deals.
      // Keep the earliest response for each unique field_label + value/file_name.
      const seen = new Set<string>();
      const deduped = (data ?? []).filter((r: any) => {
        const key = `${r.field_label ?? ""}|${r.value ?? ""}|${r.file_name ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
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

  // ── By deal_id: return file-type responses for all tasks in this deal ────
  // For shared tasks, also include responses from linked family deals
  if (!dealId) {
    return NextResponse.json({ error: "deal_id or task_id is required" }, { status: 400 });
  }

  // Step 1: Get all task IDs for this deal (personal tasks)
  const { data: dealTasks, error: tasksError } = await supabaseAdmin
    .from("tasks")
    .select("id, title, is_shared, task_template_id")
    .eq("deal_id", dealId);

  if (tasksError || !dealTasks?.length) {
    return NextResponse.json([]);
  }

  // Step 2: For shared tasks, also find matching tasks in linked family deals
  const personalTaskIds = dealTasks.filter((t) => !t.is_shared).map((t) => t.id);
  const sharedTasks = dealTasks.filter((t) => t.is_shared && t.task_template_id);

  let allSharedTaskIds: string[] = [];
  if (sharedTasks.length > 0) {
    const familyDealIds = await getFamilyDealIds(dealId);
    const sharedTemplateIds = sharedTasks.map((t) => t.task_template_id);

    const { data: familySharedTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id")
      .eq("is_shared", true)
      .in("task_template_id", sharedTemplateIds)
      .in("deal_id", familyDealIds);

    if (familySharedTasks) {
      allSharedTaskIds = familySharedTasks.map((t) => t.id);
    }
  }

  const allTaskIds = [...new Set([...personalTaskIds, ...sharedTasks.map((t) => t.id), ...allSharedTaskIds])];

  // Build title map: for shared tasks from other deals, map to the local task title
  const taskMap = new Map(dealTasks.map((t) => [t.id, t.title]));
  // Also map shared task IDs from family deals to the correct title
  if (sharedTasks.length > 0) {
    const templateToTitle = new Map(sharedTasks.map((t) => [t.task_template_id, t.title]));
    for (const sid of allSharedTaskIds) {
      if (!taskMap.has(sid)) {
        // Look up the template_id for this task to get the right title
        const { data: st } = await supabaseAdmin
          .from("tasks")
          .select("task_template_id")
          .eq("id", sid)
          .single();
        if (st?.task_template_id) {
          taskMap.set(sid, templateToTitle.get(st.task_template_id) ?? "Unknown Task");
        }
      }
    }
  }

  // Step 3: Get file-type responses
  const { data, error } = await supabaseAdmin
    .from("task_responses")
    .select("task_id, file_name, file_url, field_type")
    .in("task_id", allTaskIds)
    .eq("field_type", "file");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Step 4: If file_url is null, look up from lead_corporate_docs
  const hasNullUrls = (data ?? []).some((d) => !d.file_url);
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
        const docMap = new Map(docs.map((d) => [d.file_name, d.file_url]));
        for (const item of data ?? []) {
          if (!item.file_url && item.file_name) {
            item.file_url = docMap.get(item.file_name) ?? null;
          }
        }
      }
    }
  }

  // Step 5: Map task_id to the primary deal's shared task ID
  // The tasks GET returns shared tasks with the primary deal's task IDs,
  // so the doc column filter (taskFileDocs.filter(d => d.task_id === task.id)) matches correctly.

  // Find the primary deal ID for this family
  let primaryDealId = dealId;
  try {
    const { data: dealRow } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (dealRow?.lead_id) {
      const { data: leadRow } = await supabaseAdmin
        .from("leads")
        .select("id, parent_lead_id")
        .eq("id", dealRow.lead_id)
        .single();

      const rootId = leadRow?.parent_lead_id ?? leadRow?.id;
      if (rootId) {
        const { data: rootDeal } = await supabaseAdmin
          .from("deals")
          .select("id")
          .eq("lead_id", rootId)
          .maybeSingle();
        if (rootDeal?.id) primaryDealId = rootDeal.id;
      }
    }
  } catch {
    // fallback to dealId
  }

  // Build a map: task_template_id → primary deal's task id
  const templateToPrimaryTaskId = new Map<string, string>();
  if (primaryDealId !== dealId && sharedTasks.length > 0) {
    const sharedTemplateIds = sharedTasks.map((t) => t.task_template_id);
    const { data: primaryTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .in("task_template_id", sharedTemplateIds);

    if (primaryTasks) {
      for (const pt of primaryTasks) {
        if (pt.task_template_id) templateToPrimaryTaskId.set(pt.task_template_id, pt.id);
      }
    }
  } else {
    // This IS the primary deal — shared task IDs are already correct
    for (const st of sharedTasks) {
      if (st.task_template_id) templateToPrimaryTaskId.set(st.task_template_id, st.id);
    }
  }

  // Build reverse map: any family shared task id → template id
  const familyTaskIdToTemplate = new Map<string, string>();
  if (sharedTasks.length > 0) {
    const sharedTemplateIds = sharedTasks.map((t) => t.task_template_id);
    const { data: allFamilySharedTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id")
      .eq("is_shared", true)
      .in("task_template_id", sharedTemplateIds)
      .in("deal_id", await getFamilyDealIds(dealId));

    if (allFamilySharedTasks) {
      for (const ft of allFamilySharedTasks) {
        if (ft.task_template_id) familyTaskIdToTemplate.set(ft.id, ft.task_template_id);
      }
    }
  }

  const result = (data ?? []).map((d) => {
    let effectiveTaskId = d.task_id;
    let title = taskMap.get(d.task_id) ?? "Unknown Task";

    // If response is from a family deal's shared task, remap to the primary deal's task ID
    const templateId = familyTaskIdToTemplate.get(d.task_id);
    if (templateId && templateToPrimaryTaskId.has(templateId)) {
      effectiveTaskId = templateToPrimaryTaskId.get(templateId)!;
      title = taskMap.get(effectiveTaskId) ?? dealTasks.find((t) => t.task_template_id === templateId)?.title ?? title;
    }

    return {
      ...d,
      task_id: effectiveTaskId,
      task_title: title,
    };
  });

  return NextResponse.json(result);
}
