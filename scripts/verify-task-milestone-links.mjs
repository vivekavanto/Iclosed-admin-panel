/**
 * Drift detector: asserts that every live, template-backed task points at the
 * milestone matching its task template's CURRENT `stage_template_id` on the
 * same deal. This is the invariant the conversion seeding + the
 * reconcileDealMilestoneLinks cascade are supposed to uphold.
 *
 * Exits 0 when clean, 1 when any stale/missing link is found (so it can gate a
 * deploy or run as a post-migration check). Read-only — never writes.
 *
 * Reads dev credentials from .env.
 *
 *   node scripts/verify-task-milestone-links.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

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
console.log(`Connecting to: ${url}\n`);

async function fetchAll(table, columns, build = (q) => q) {
  const PAGE = 1000;
  let from = 0;
  const out = [];
  for (;;) {
    const { data, error } = await build(
      supabase.from(table).select(columns),
    ).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

const stageTemplates = await fetchAll(
  "stage_templates",
  "id, name, is_deleted",
  (q) => q.eq("is_deleted", false),
);
const stageById = new Map(stageTemplates.map((s) => [s.id, s]));

const taskTemplates = await fetchAll("task_templates", "id, stage_template_id");
const ttStageById = new Map(taskTemplates.map((t) => [t.id, t.stage_template_id]));

const milestones = await fetchAll(
  "milestones",
  "id, deal_id, stage_template_id, title, is_deleted",
);
// dealId -> stage_template_id -> { id, is_deleted }
const msByDealStage = new Map();
for (const m of milestones) {
  if (!m.stage_template_id) continue;
  if (!msByDealStage.has(m.deal_id)) msByDealStage.set(m.deal_id, new Map());
  const inner = msByDealStage.get(m.deal_id);
  const cur = inner.get(m.stage_template_id);
  if (!cur || (cur.is_deleted && !m.is_deleted)) inner.set(m.stage_template_id, m);
}

const tasks = await fetchAll(
  "tasks",
  "id, deal_id, milestone_id, task_template_id, title",
  (q) => q.eq("is_deleted", false).not("task_template_id", "is", null),
);

const offenders = [];
let checked = 0;
for (const t of tasks) {
  const stageId = ttStageById.get(t.task_template_id);
  if (!stageId || !stageById.has(stageId)) continue; // template has no live stage → nothing to assert
  checked++;

  const target = msByDealStage.get(t.deal_id)?.get(stageId);
  // A soft-deleted target is an intentional per-deal removal — not a violation.
  if (target?.is_deleted) continue;

  if (!target) {
    offenders.push({ id: t.id, title: t.title, deal: t.deal_id, reason: "no milestone for template stage", stage: stageById.get(stageId).name });
  } else if (t.milestone_id !== target.id) {
    offenders.push({ id: t.id, title: t.title, deal: t.deal_id, reason: "points at wrong milestone", stage: stageById.get(stageId).name });
  }
}

console.log(`Checked ${checked} template-backed task(s) with a live stage.`);
if (offenders.length === 0) {
  console.log("\nOK — every task is linked to the milestone matching its template's stage.");
  process.exit(0);
}

console.log(`\nFOUND ${offenders.length} stale/missing link(s):`);
const byStage = {};
for (const o of offenders) byStage[`${o.stage} (${o.reason})`] = (byStage[`${o.stage} (${o.reason})`] ?? 0) + 1;
for (const [k, n] of Object.entries(byStage).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n.toString().padStart(4)}  ${k}`);
}
console.log("\nRun: node scripts/backfill-task-milestone-links.mjs --all --apply   to fix.");
process.exit(1);
