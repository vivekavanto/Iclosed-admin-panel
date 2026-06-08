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
