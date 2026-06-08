/**
 * One-time backfill: reconcile every template-backed task's `milestone_id` with
 * the milestone that matches its task template's CURRENT `stage_template_id`.
 *
 * Why this exists: deal-level rows are snapshots copied from templates at
 * conversion time. When a task template is later repointed to a different stage
 * (or a new stage is added), already-seeded `tasks.milestone_id` links go stale
 * — the task keeps driving the OLD milestone. This is what caused the
 * "Mortgage Representative Details" task to update "Financing Firm -> Mortgage
 * Instructions" on 149 existing deals.
 *
 * What it does, per live (is_deleted=false) task that has a task_template with a
 * stage_template_id:
 *   1. Resolve the milestone on the SAME deal whose stage_template_id matches
 *      the template's current stage_template_id.
 *   2. If that milestone is missing, seed it from the stage template (unless a
 *      soft-deleted milestone for that stage exists — then skip, it was
 *      intentionally removed).
 *   3. If the task points somewhere else, repoint it.
 *   4. Recalculate milestone statuses for every touched deal family so a stale
 *      "Completed" on the old milestone resets and the new one rolls up.
 *
 * Reads dev credentials from .env. SAFE BY DEFAULT — dry run unless you pass
 * `--apply` (or set APPLY=1). Idempotent: re-running after an apply is a no-op.
 *
 * SCOPE: by default this only reconciles tasks whose template's target stage is
 * "Mortgage Representative Details" — i.e. exactly the reported bug. Pass
 * `--all` (or SCOPE_STAGE_NAME=...) to reconcile every stage.
 *
 *   node scripts/backfill-task-milestone-links.mjs            # dry run, mortgage only
 *   node scripts/backfill-task-milestone-links.mjs --apply    # write, mortgage only
 *   node scripts/backfill-task-milestone-links.mjs --all      # dry run, every stage
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const ALL = process.argv.includes("--all");
const SCOPE_STAGE_NAME = ALL
  ? null
  : (process.env.SCOPE_STAGE_NAME ?? "Mortgage Representative Details");

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
console.log(`Mode: ${APPLY ? "APPLY (writes enabled)" : "DRY RUN (no writes)"}`);
console.log(`Scope: ${SCOPE_STAGE_NAME ? `target stage = "${SCOPE_STAGE_NAME}"` : "ALL stages"}\n`);

// ── Load reference data ────────────────────────────────────────────────────
const stageTemplates = await fetchAll(
  "stage_templates",
  "id, name, order_index, email_template_id, description, auto_complete, is_deleted",
  (q) => q.eq("is_deleted", false),
);
const stageById = new Map(stageTemplates.map((s) => [s.id, s]));
// Stage template ids that are in-scope for this run.
const scopedStageIds = new Set(
  stageTemplates
    .filter((s) => !SCOPE_STAGE_NAME || (s.name ?? "").toLowerCase() === SCOPE_STAGE_NAME.toLowerCase())
    .map((s) => s.id),
);

const taskTemplates = await fetchAll("task_templates", "id, stage_template_id");
const ttStageById = new Map(taskTemplates.map((t) => [t.id, t.stage_template_id]));

// All milestones (incl. soft-deleted) so we can tell "never existed" from
// "intentionally removed".
const allMilestones = await fetchAll(
  "milestones",
  "id, deal_id, stage_template_id, title, status, is_deleted",
);
// dealId -> stageTemplateId -> milestone row
const msByDealStage = new Map();
for (const m of allMilestones ?? []) {
  if (!m.stage_template_id) continue;
  if (!msByDealStage.has(m.deal_id)) msByDealStage.set(m.deal_id, new Map());
  // Prefer a live milestone if both a live and deleted one exist.
  const inner = msByDealStage.get(m.deal_id);
  const existing = inner.get(m.stage_template_id);
  if (!existing || (existing.is_deleted && !m.is_deleted)) {
    inner.set(m.stage_template_id, m);
  }
}

// All live, template-backed tasks.
const tasks = await fetchAll(
  "tasks",
  "id, deal_id, milestone_id, task_template_id, title",
  (q) => q.eq("is_deleted", false).not("task_template_id", "is", null),
);

// ── Plan changes ───────────────────────────────────────────────────────────
const milestonesToCreate = []; // { deal_id, stage, taskIds: [] }
const createKey = new Map(); // `${deal}|${stage}` -> index in milestonesToCreate
const repoints = []; // { taskId, from, toStageKey, title }
const skippedSoftDeleted = []; // { taskId, title }
let alreadyCorrect = 0;

for (const t of tasks ?? []) {
  const stageId = ttStageById.get(t.task_template_id);
  if (!stageId) continue; // template has no stage → no milestone expected
  if (!stageById.has(stageId)) continue; // stage template deleted/unknown
  if (!scopedStageIds.has(stageId)) continue; // out of scope for this run

  const inner = msByDealStage.get(t.deal_id);
  const target = inner?.get(stageId);

  if (target && !target.is_deleted) {
    if (t.milestone_id === target.id) {
      alreadyCorrect++;
    } else {
      repoints.push({ taskId: t.id, from: t.milestone_id, targetId: target.id, title: t.title });
    }
    continue;
  }

  if (target && target.is_deleted) {
    // Stage's milestone was intentionally removed on this deal — leave alone.
    skippedSoftDeleted.push({ taskId: t.id, title: t.title });
    continue;
  }

  // No milestone for this stage on this deal → must create one, then repoint.
  const key = `${t.deal_id}|${stageId}`;
  if (!createKey.has(key)) {
    createKey.set(key, milestonesToCreate.length);
    milestonesToCreate.push({ deal_id: t.deal_id, stage: stageById.get(stageId), taskIds: [] });
  }
  milestonesToCreate[createKey.get(key)].taskIds.push({ taskId: t.id, title: t.title });
}

// ── Report ─────────────────────────────────────────────────────────────────
const repointByStage = {};
for (const r of repoints) {
  const ms = (allMilestones ?? []).find((m) => m.id === r.from);
  const fromName = ms?.title ?? (r.from ? "(unknown milestone)" : "(no milestone)");
  repointByStage[fromName] = (repointByStage[fromName] ?? 0) + 1;
}

// Breakdown of the create+repoint work by the stage we'll link tasks TO.
const createByStage = {};
let createTaskCount = 0;
for (const job of milestonesToCreate) {
  const name = job.stage.name;
  createByStage[name] = (createByStage[name] ?? 0) + job.taskIds.length;
  createTaskCount += job.taskIds.length;
}

console.log("── Summary ──────────────────────────────────────────");
console.log(`Live template-backed tasks scanned : ${tasks?.length ?? 0}`);
console.log(`In-scope tasks already correct     : ${alreadyCorrect}`);
console.log(`Tasks to repoint (target exists)   : ${repoints.length}`);
console.log(`Milestones to create (missing)     : ${milestonesToCreate.length}`);
console.log(`Tasks linked via new milestones    : ${createTaskCount}`);
console.log(`Tasks skipped (stage soft-deleted) : ${skippedSoftDeleted.length}`);
console.log(`Total tasks to fix                 : ${repoints.length + createTaskCount}`);

if (repoints.length > 0) {
  console.log("\nRepoints grouped by the WRONG milestone they currently point to:");
  for (const [name, n] of Object.entries(repointByStage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  <- ${name}`);
  }
}
if (createTaskCount > 0) {
  console.log("\nTasks fixed by creating a missing milestone, grouped by target stage:");
  for (const [name, n] of Object.entries(createByStage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n.toString().padStart(4)}  -> ${name}`);
  }
}

if (!APPLY) {
  console.log("\nDRY RUN — no changes written. Re-run with --apply to commit.");
  process.exit(0);
}

// ── Apply ──────────────────────────────────────────────────────────────────
console.log("\nApplying changes...");
const touchedDealIds = new Set();

// 1. Create missing milestones, then repoint their tasks.
for (const job of milestonesToCreate) {
  const st = job.stage;
  const now = new Date().toISOString();
  const { data: created, error } = await supabase
    .from("milestones")
    .insert({
      deal_id: job.deal_id,
      title: st.name,
      status: st.auto_complete ? "Completed" : "Pending",
      completed_at: st.auto_complete ? now : null,
      order_index: st.order_index,
      email_template_id: st.email_template_id ?? null,
      stage_template_id: st.id,
      description: st.description ?? null,
    })
    .select("id")
    .single();
  if (error) {
    console.error(`  create milestone failed (deal ${job.deal_id}): ${error.message}`);
    continue;
  }
  touchedDealIds.add(job.deal_id);
  for (const { taskId } of job.taskIds) {
    const { error: upErr } = await supabase
      .from("tasks")
      .update({ milestone_id: created.id })
      .eq("id", taskId);
    if (upErr) console.error(`  repoint task ${taskId} failed: ${upErr.message}`);
  }
}

// 2. Repoint tasks whose target milestone already existed.
for (const r of repoints) {
  const { error } = await supabase
    .from("tasks")
    .update({ milestone_id: r.targetId })
    .eq("id", r.taskId);
  if (error) {
    console.error(`  repoint task ${r.taskId} failed: ${error.message}`);
    continue;
  }
  const task = (tasks ?? []).find((t) => t.id === r.taskId);
  if (task) touchedDealIds.add(task.deal_id);
}

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
