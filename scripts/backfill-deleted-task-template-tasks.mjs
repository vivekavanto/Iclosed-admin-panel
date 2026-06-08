/**
 * One-time backfill: soft-delete the per-deal `tasks` that were cloned from a
 * task template which has since been deleted (task_templates.is_deleted = true).
 *
 * Why this exists: tasks are SNAPSHOTS copied from task_templates at
 * lead-conversion time (see convertLead.ts), not live references. Historically
 * the task-template DELETE route only flipped is_deleted on the template row,
 * so the cloned tasks stayed live on every EXISTING deal — the task vanished
 * for new deals but lingered on already-active customer dashboards. The route
 * now cascades the delete, but this script cleans up the tasks orphaned by
 * deletes that happened BEFORE that fix.
 *
 * What it does, per live (is_deleted=false) task whose task_template is deleted:
 *   1. Soft-delete the task (is_deleted = true). task_responses are kept intact
 *      so the action stays reversible.
 *   2. Recalculate milestone statuses for every touched deal family so a
 *      milestone that was stuck "In Progress"/"Pending" only because of the
 *      now-removed task rolls up correctly.
 *
 * Reads dev credentials from .env. SAFE BY DEFAULT — dry run unless you pass
 * `--apply` (or set APPLY=1). Idempotent: re-running after an apply is a no-op.
 *
 *   node scripts/backfill-deleted-task-template-tasks.mjs            # dry run
 *   node scripts/backfill-deleted-task-template-tasks.mjs --apply    # write
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

// Supabase caps a single select at 1000 rows — page through everything.
async function fetchAll(table, columns, build = (q) => q) {
  const PAGE = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    let q = supabase.from(table).select(columns).range(from, from + PAGE - 1);
    q = build(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`Connecting to: ${url}`);
console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}\n`);

// ── Load reference data ────────────────────────────────────────────────────
// Deleted task templates — these are the ones whose cloned tasks are orphaned.
const deletedTemplates = await fetchAll(
  "task_templates",
  "id, name",
  (q) => q.eq("is_deleted", true),
);
const deletedTplById = new Map(deletedTemplates.map((t) => [t.id, t]));
const deletedTplIds = [...deletedTplById.keys()];

if (deletedTplIds.length === 0) {
  console.log("No deleted task templates found — nothing to do.");
  process.exit(0);
}

// Live tasks still pointing at a deleted template.
const orphanedTasks = await fetchAll(
  "tasks",
  "id, deal_id, title, task_template_id",
  (q) =>
    q
      .eq("is_deleted", false)
      .in("task_template_id", deletedTplIds),
);

// ── Report ─────────────────────────────────────────────────────────────────
const byTemplate = {};
for (const t of orphanedTasks) {
  const name = deletedTplById.get(t.task_template_id)?.name ?? "(unknown template)";
  byTemplate[name] = (byTemplate[name] ?? 0) + 1;
}
const touchedDealIds = new Set(orphanedTasks.map((t) => t.deal_id));

console.log("── Summary ──────────────────────────────────────────");
console.log(`Deleted task templates              : ${deletedTplIds.length}`);
console.log(`Orphaned live tasks to soft-delete  : ${orphanedTasks.length}`);
console.log(`Deals affected                      : ${touchedDealIds.size}`);

if (orphanedTasks.length > 0) {
  console.log("\nOrphaned tasks grouped by the deleted template they came from:");
  for (const [name, n] of Object.entries(byTemplate).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  <- ${name}`);
  }
}

if (orphanedTasks.length === 0) {
  console.log("\nNothing to clean up.");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDRY RUN — no changes written. Re-run with --apply to commit.");
  process.exit(0);
}

// ── Apply ──────────────────────────────────────────────────────────────────
console.log("\nApplying changes...");
const taskIds = orphanedTasks.map((t) => t.id);
let softDeleted = 0;
for (let i = 0; i < taskIds.length; i += 200) {
  const slice = taskIds.slice(i, i + 200);
  const { data, error } = await supabase
    .from("tasks")
    .update({ is_deleted: true })
    .in("id", slice)
    .select("id");
  if (error) {
    console.error(`  soft-delete batch failed: ${error.message}`);
    continue;
  }
  softDeleted += data?.length ?? 0;
}
console.log(`Soft-deleted ${softDeleted} task(s).`);

console.log(`\nRecalculating milestones for ${touchedDealIds.size} touched deal(s)...`);
for (const dealId of touchedDealIds) {
  try {
    await recalcMilestonesForFamily(supabase, dealId);
  } catch (e) {
    console.error(`  recalc failed for deal ${dealId}: ${e.message}`);
  }
}

console.log("\nDone.");

// ── Recalc (ported from src/lib/recalcMilestones.ts, no email side-effects) ──
async function recalcMilestonesForFamily(sb, dealId) {
  const familyDealIds = await getFamilyDealIds(sb, dealId);
  const primaryDealId = await getPrimaryDealId(sb, dealId);

  const { data: familyMilestones } = await sb
    .from("milestones")
    .select("id, deal_id, stage_template_id, status")
    .in("deal_id", familyDealIds)
    .eq("is_deleted", false);

  const primaryMsMap = new Map(); // milestone_id -> stage_template_id
  const dealMsMap = new Map(); // deal_id -> Map(stage_template_id -> milestone_id)
  for (const m of familyMilestones ?? []) {
    if (m.deal_id === primaryDealId) primaryMsMap.set(m.id, m.stage_template_id);
    if (!dealMsMap.has(m.deal_id)) dealMsMap.set(m.deal_id, new Map());
    dealMsMap.get(m.deal_id).set(m.stage_template_id, m.id);
  }

  const { data: sharedTasks } = await sb
    .from("tasks")
    .select("milestone_id, status")
    .eq("deal_id", primaryDealId)
    .eq("is_shared", true)
    .eq("is_deleted", false)
    .not("milestone_id", "is", null);

  for (const famDealId of familyDealIds) {
    const { data: personalTasks } = await sb
      .from("tasks")
      .select("milestone_id, status")
      .eq("deal_id", famDealId)
      .or("is_shared.is.null,is_shared.eq.false")
      .eq("is_deleted", false)
      .not("milestone_id", "is", null);

    const localMsMap = dealMsMap.get(famDealId) || new Map();
    const milestoneTaskMap = new Map();

    for (const t of sharedTasks ?? []) {
      let mappedMsId = t.milestone_id;
      if (famDealId !== primaryDealId) {
        const templId = primaryMsMap.get(t.milestone_id);
        if (templId && localMsMap.has(templId)) mappedMsId = localMsMap.get(templId);
        else continue;
      }
      if (!mappedMsId) continue;
      const arr = milestoneTaskMap.get(mappedMsId) ?? [];
      arr.push(t.status);
      milestoneTaskMap.set(mappedMsId, arr);
    }
    for (const t of personalTasks ?? []) {
      if (!t.milestone_id) continue;
      const arr = milestoneTaskMap.get(t.milestone_id) ?? [];
      arr.push(t.status);
      milestoneTaskMap.set(t.milestone_id, arr);
    }

    const validLocalMilestones = new Set(localMsMap.values());
    for (const [msId, statuses] of milestoneTaskMap.entries()) {
      if (!validLocalMilestones.has(msId)) continue;
      const allDone = statuses.length > 0 && statuses.every((s) => s === "Completed");
      const anyActive = statuses.some((s) => s === "In Progress" || s === "Completed");
      const newStatus = allDone ? "Completed" : anyActive ? "In Progress" : "Pending";
      const msUpdates = { status: newStatus, completed_at: allDone ? new Date().toISOString() : null };
      if (!allDone) msUpdates.email_sent = false;
      await sb.from("milestones").update(msUpdates).eq("id", msId);
    }
  }
}

async function getPrimaryDealId(sb, dealId) {
  const { data: deal } = await sb.from("deals").select("lead_id").eq("id", dealId).single();
  if (!deal?.lead_id) return dealId;
  const { data: lead } = await sb
    .from("leads").select("id, parent_lead_id").eq("id", deal.lead_id).single();
  const rootLeadId = lead?.parent_lead_id ?? lead?.id;
  if (!rootLeadId) return dealId;
  const { data: rootDeal } = await sb
    .from("deals").select("id").eq("lead_id", rootLeadId).maybeSingle();
  return rootDeal?.id ?? dealId;
}

async function getFamilyDealIds(sb, dealId) {
  const { data: deal } = await sb.from("deals").select("lead_id").eq("id", dealId).single();
  if (!deal?.lead_id) return [dealId];
  const { data: lead } = await sb
    .from("leads").select("id, parent_lead_id").eq("id", deal.lead_id).single();
  if (!lead) return [dealId];
  const rootLeadId = lead.parent_lead_id ?? lead.id;
  const { data: familyLeads } = await sb
    .from("leads").select("id").or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);
  if (!familyLeads || familyLeads.length <= 1) return [dealId];
  const { data: familyDeals } = await sb
    .from("deals").select("id").in("lead_id", familyLeads.map((l) => l.id)).eq("is_deleted", false);
  return familyDeals?.map((d) => d.id) ?? [dealId];
}
