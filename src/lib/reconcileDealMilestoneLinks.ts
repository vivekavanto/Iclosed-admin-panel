import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { recalcMilestonesForFamily } from "./recalcMilestones";

/**
 * Keeps already-seeded deals in sync when admin edits the templates that deals
 * were originally cloned from.
 *
 * Background: at conversion time `convertLead` snapshots stage_templates →
 * milestones and task_templates → tasks, freezing each task's `milestone_id`.
 * Editing a template afterwards does NOT touch those snapshots, so existing
 * deals drift (a repointed task keeps driving its OLD milestone; a brand-new
 * milestone never appears on older deals). These helpers are the cascade that
 * closes that gap. They're idempotent and never resurrect a soft-deleted
 * milestone (treated as an intentional per-deal removal).
 */

const PAGE = 1000;

/** Page through a deal-id-scoped select so we don't silently cap at 1000 rows. */
async function fetchAllByDealIds<T>(
  table: string,
  columns: string,
  dealIds: string[],
  extra: (q: any) => any = (q) => q,
): Promise<T[]> {
  if (dealIds.length === 0) return [];
  const out: T[] = [];
  // Chunk the IN list too — very large families/deal sets can blow past URL limits.
  for (let i = 0; i < dealIds.length; i += 200) {
    const slice = dealIds.slice(i, i + 200);
    let from = 0;
    for (;;) {
      const q = extra(
        supabaseAdmin.from(table).select(columns).in("deal_id", slice),
      ).range(from, from + PAGE - 1);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...((data ?? []) as T[]));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  }
  return out;
}

/** Resolve the family's primary (root-lead) deal — recalc keys shared tasks off it. */
async function getPrimaryDealId(dealId: string): Promise<string> {
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .eq("id", dealId)
    .single();
  if (!deal?.lead_id) return dealId;

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();
  const rootLeadId = lead?.parent_lead_id ?? lead?.id;
  if (!rootLeadId) return dealId;

  const { data: rootDeal } = await supabaseAdmin
    .from("deals")
    .select("id")
    .eq("lead_id", rootLeadId)
    .maybeSingle();
  return rootDeal?.id ?? dealId;
}

/** Recalc every distinct family covering the given deals, with emails suppressed. */
async function recalcFamiliesForDeals(dealIds: string[]) {
  const seen = new Set<string>();
  for (const dealId of dealIds) {
    if (seen.has(dealId)) continue;
    try {
      const familyDealIds = await getFamilyDealIds(dealId);
      const primaryDealId = await getPrimaryDealId(dealId);
      familyDealIds.forEach((id) => seen.add(id));
      seen.add(dealId);
      await recalcMilestonesForFamily(familyDealIds, primaryDealId, {
        sendEmails: false,
      });
    } catch {
      // Non-blocking per family — a stale rollup is recoverable.
    }
  }
}

type StageTemplate = {
  id: string;
  name: string;
  lead_type: string;
  order_index: number | null;
  email_template_id: string | null;
  description: unknown | null;
  auto_complete: boolean | null;
};

async function loadStageTemplate(stageTemplateId: string): Promise<StageTemplate | null> {
  const { data } = await supabaseAdmin
    .from("stage_templates")
    .select("id, name, lead_type, order_index, email_template_id, description, auto_complete")
    .eq("id", stageTemplateId)
    .maybeSingle();
  return (data as StageTemplate) ?? null;
}

/**
 * Repoint every live task on `taskTemplateId` to the milestone matching the
 * template's CURRENT stage. Creates the milestone on a deal if it's missing
 * (unless a soft-deleted one exists there). When `newStageTemplateId` is null,
 * the tasks are unlinked (`milestone_id = null`).
 *
 * Returns counts for logging. Safe to call when nothing changed (no-op).
 */
export async function repointTasksForTemplate(
  taskTemplateId: string,
  newStageTemplateId: string | null,
): Promise<{ repointed: number; created: number }> {
  // All live tasks cloned from this template.
  const tasks: { id: string; deal_id: string; milestone_id: string | null }[] = [];
  {
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("tasks")
        .select("id, deal_id, milestone_id")
        .eq("task_template_id", taskTemplateId)
        .eq("is_deleted", false)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`tasks: ${error.message}`);
      tasks.push(...(data ?? []));
      if (!data || data.length < PAGE) break;
      from += PAGE;
    }
  }
  if (tasks.length === 0) return { repointed: 0, created: 0 };

  const dealIds = [...new Set(tasks.map((t) => t.deal_id))];

  // ── Unlink case: template no longer has a stage. ──────────────────────────
  if (!newStageTemplateId) {
    const stale = tasks.filter((t) => t.milestone_id !== null).map((t) => t.id);
    let repointed = 0;
    for (let i = 0; i < stale.length; i += 200) {
      const { data } = await supabaseAdmin
        .from("tasks")
        .update({ milestone_id: null })
        .in("id", stale.slice(i, i + 200))
        .select("id");
      repointed += data?.length ?? 0;
    }
    if (repointed > 0) await recalcFamiliesForDeals(dealIds);
    return { repointed, created: 0 };
  }

  const stage = await loadStageTemplate(newStageTemplateId);
  if (!stage) return { repointed: 0, created: 0 }; // unknown/deleted stage — leave links alone

  // Existing milestones (incl. soft-deleted) for this stage across the deals.
  const milestones = await fetchAllByDealIds<{
    id: string;
    deal_id: string;
    is_deleted: boolean | null;
  }>("milestones", "id, deal_id, is_deleted", dealIds, (q) =>
    q.eq("stage_template_id", newStageTemplateId),
  );
  const liveMsByDeal = new Map<string, string>();
  const deletedMsByDeal = new Set<string>();
  for (const m of milestones) {
    if (m.is_deleted) deletedMsByDeal.add(m.deal_id);
    else liveMsByDeal.set(m.deal_id, m.id);
  }

  // Create the milestone on deals that lack it (and never had it removed).
  let created = 0;
  const now = new Date().toISOString();
  const dealsNeedingMs = dealIds.filter(
    (d) => !liveMsByDeal.has(d) && !deletedMsByDeal.has(d),
  );
  for (const dealId of dealsNeedingMs) {
    const { data, error } = await supabaseAdmin
      .from("milestones")
      .insert({
        deal_id: dealId,
        title: stage.name,
        status: stage.auto_complete ? "Completed" : "Pending",
        completed_at: stage.auto_complete ? now : null,
        order_index: stage.order_index,
        email_template_id: stage.email_template_id ?? null,
        stage_template_id: stage.id,
        description: (stage.description ?? null) as never,
      })
      .select("id")
      .single();
    if (!error && data) {
      liveMsByDeal.set(dealId, data.id);
      created++;
    }
  }

  // Repoint each task whose link is stale (skip deals whose stage was removed).
  const touchedDealIds = new Set<string>();
  for (const t of tasks) {
    const targetMsId = liveMsByDeal.get(t.deal_id);
    if (!targetMsId) continue; // soft-deleted stage on this deal — leave alone
    if (t.milestone_id === targetMsId) continue;
    const { error } = await supabaseAdmin
      .from("tasks")
      .update({ milestone_id: targetMsId })
      .eq("id", t.id);
    if (!error) touchedDealIds.add(t.deal_id);
  }

  if (created > 0 || touchedDealIds.size > 0) {
    await recalcFamiliesForDeals(dealIds);
  }
  return { repointed: touchedDealIds.size, created };
}

type TaskTemplate = {
  id: string;
  name: string;
  lead_type: string;
  role_type: string | null;
  is_shared: boolean | null;
  is_default: boolean | null;
  stage_template_id: string | null;
};

async function loadTaskTemplate(taskTemplateId: string): Promise<TaskTemplate | null> {
  const { data } = await supabaseAdmin
    .from("task_templates")
    .select("id, name, lead_type, role_type, is_shared, is_default, stage_template_id")
    .eq("id", taskTemplateId)
    .maybeSingle();
  return (data as TaskTemplate) ?? null;
}

/** Active, non-deleted deals whose `type` includes the stage's lead_type. */
async function dealsForLeadType(leadType: string): Promise<string[]> {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("deals")
      .select("id")
      .eq("is_deleted", false)
      .ilike("type", `%${leadType}%`)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`deals: ${error.message}`);
    out.push(...((data ?? []).map((d) => d.id)));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

/**
 * Create the milestone for a (new or edited) stage template on every existing
 * deal of its lead_type that doesn't already have it. Skips deals where the
 * milestone was soft-deleted. No recalc needed — a fresh milestone has no tasks
 * yet, so its status starts at the template default.
 */
export async function backfillMilestoneForStage(
  stageTemplateId: string,
): Promise<{ created: number }> {
  const stage = await loadStageTemplate(stageTemplateId);
  if (!stage) return { created: 0 };

  const dealIds = await dealsForLeadType(stage.lead_type);
  if (dealIds.length === 0) return { created: 0 };

  const existing = await fetchAllByDealIds<{ deal_id: string }>(
    "milestones",
    "deal_id",
    dealIds,
    (q) => q.eq("stage_template_id", stageTemplateId),
  );
  const haveMs = new Set(existing.map((m) => m.deal_id));
  const missing = dealIds.filter((d) => !haveMs.has(d));
  if (missing.length === 0) return { created: 0 };

  const now = new Date().toISOString();
  const rows = missing.map((deal_id) => ({
    deal_id,
    title: stage.name,
    status: stage.auto_complete ? ("Completed" as const) : ("Pending" as const),
    completed_at: stage.auto_complete ? now : null,
    order_index: stage.order_index,
    email_template_id: stage.email_template_id ?? null,
    stage_template_id: stage.id,
    description: (stage.description ?? null) as never,
  }));

  let created = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data } = await supabaseAdmin
      .from("milestones")
      .insert(rows.slice(i, i + 200))
      .select("id");
    created += data?.length ?? 0;
  }
  return { created };
}

/**
 * Seed a (newly created) task template onto every existing deal of its
 * lead_type that doesn't already have it, mirroring how `convertLead` clones
 * task_templates → tasks at conversion time. Without this, a new task template
 * would only ever appear on FUTURE deals, not already-active dashboards — the
 * mirror image of the delete cascade.
 *
 * Matches conversion semantics:
 *   - Only `is_default` templates are auto-seeded (non-default ones are opt-in,
 *     never added on conversion either).
 *   - A `is_shared` task is skipped on co-purchaser deals (parent_lead_id set),
 *     exactly as conversion does.
 *   - Each new task is linked to the deal's live milestone for the template's
 *     stage (if any), so it rolls up into the right milestone.
 *   - Idempotent: deals that already carry this task_template_id are skipped.
 *
 * Recalcs touched families since a fresh Pending task can flip a previously
 * "Completed" milestone back to "In Progress"/"Pending".
 */
export async function backfillTaskForTemplate(
  taskTemplateId: string,
): Promise<{ created: number }> {
  const tpl = await loadTaskTemplate(taskTemplateId);
  if (!tpl) return { created: 0 };
  // Non-default templates are opt-in and never auto-seeded on conversion, so
  // we don't push them onto existing deals either.
  if (!tpl.is_default) return { created: 0 };

  const dealIds = await dealsForLeadType(tpl.lead_type);
  if (dealIds.length === 0) return { created: 0 };

  // Deals that already carry this task → skip (idempotent).
  const existingTasks = await fetchAllByDealIds<{ deal_id: string }>(
    "tasks",
    "deal_id",
    dealIds,
    (q) => q.eq("task_template_id", taskTemplateId),
  );
  const haveTask = new Set(existingTasks.map((t) => t.deal_id));

  // Live milestone per deal for this template's stage, so the new task links to
  // the right milestone (matching conversion's stageToMilestone behavior).
  const liveMsByDeal = new Map<string, string>();
  if (tpl.stage_template_id) {
    const milestones = await fetchAllByDealIds<{ id: string; deal_id: string }>(
      "milestones",
      "id, deal_id",
      dealIds,
      (q) => q.eq("stage_template_id", tpl.stage_template_id).eq("is_deleted", false),
    );
    for (const m of milestones) liveMsByDeal.set(m.deal_id, m.id);
  }

  // Co-purchaser deals: a shared task is skipped for them, just like conversion.
  // Resolve each deal's lead → parent_lead_id to know which are co-purchasers.
  const coPurchaserDeals = new Set<string>();
  if (tpl.is_shared) {
    const dealLeads = await fetchAllByDealIds<{ id: string; lead_id: string | null }>(
      "deals",
      "id, lead_id",
      dealIds,
      (q) => q,
    );
    const leadIds = [...new Set(dealLeads.map((d) => d.lead_id).filter(Boolean) as string[])];
    const parentByLead = new Map<string, string | null>();
    for (let i = 0; i < leadIds.length; i += 200) {
      const { data } = await supabaseAdmin
        .from("leads")
        .select("id, parent_lead_id")
        .in("id", leadIds.slice(i, i + 200));
      for (const l of data ?? []) parentByLead.set(l.id, l.parent_lead_id ?? null);
    }
    for (const d of dealLeads) {
      if (d.lead_id && parentByLead.get(d.lead_id)) coPurchaserDeals.add(d.id);
    }
  }

  const targetDeals = dealIds.filter(
    (d) => !haveTask.has(d) && !(tpl.is_shared && coPurchaserDeals.has(d)),
  );
  if (targetDeals.length === 0) return { created: 0 };

  const rows = targetDeals.map((deal_id) => ({
    deal_id,
    title: tpl.name,
    status: "Pending" as const,
    role_type: tpl.role_type ?? "Client",
    task_template_id: tpl.id,
    is_shared: tpl.is_shared ?? false,
    milestone_id: tpl.stage_template_id ? (liveMsByDeal.get(deal_id) ?? null) : null,
  }));

  let created = 0;
  const touchedDealIds: string[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    const slice = rows.slice(i, i + 200);
    const { data } = await supabaseAdmin.from("tasks").insert(slice).select("deal_id");
    created += data?.length ?? 0;
    for (const r of data ?? []) touchedDealIds.push(r.deal_id);
  }

  // A new Pending task can change a milestone's rollup, so recalc the families
  // of deals that actually got a milestone-linked task.
  const dealsToRecalc = [
    ...new Set(
      rows.filter((r) => r.milestone_id).map((r) => r.deal_id),
    ),
  ];
  if (dealsToRecalc.length > 0) await recalcFamiliesForDeals(dealsToRecalc);

  return { created };
}
