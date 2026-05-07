/**
 * One-shot cleanup — removes duplicate milestones & tasks from existing
 * combined-type deals (e.g. "Purchase & Sale"). Re-links any tasks pointing
 * at a removed duplicate milestone to the surviving one, and re-links
 * task_responses pointing at a removed duplicate task to the surviving one.
 *
 * Run with:    node scripts/cleanup-duplicate-deal-items.mjs
 * Dry run:     node scripts/cleanup-duplicate-deal-items.mjs --dry-run
 * Single deal: node scripts/cleanup-duplicate-deal-items.mjs --deal=<uuid>
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";

const COMPLETED = "Completed";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dealArg = args.find((a) => a.startsWith("--deal="));
const onlyDealId = dealArg ? dealArg.split("=")[1] : null;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const lower = (s) => (s ?? "").toLowerCase().trim();
const isCombined = (type) => {
  const t = lower(type);
  return t.includes("purchase") && t.includes("sale");
};

async function fetchDeals() {
  let q = supabase.from("deals").select("id, type");
  if (onlyDealId) q = q.eq("id", onlyDealId);
  const { data, error } = await q;
  if (error) throw new Error(`fetch deals: ${error.message}`);
  return (data ?? []).filter((d) => isCombined(d.type));
}

async function dedupeMilestones(dealId) {
  const { data: rows, error } = await supabase
    .from("milestones")
    .select("id, title, status, completed_at, order_index, email_sent, created_at, stage_template_id")
    .eq("deal_id", dealId)
    .order("order_index", { ascending: true })
    .order("created_at", { ascending: true });

  if (error) throw new Error(`fetch milestones (${dealId}): ${error.message}`);

  // Dedupe by (stage_template_id) — items with the same template id are
  // duplicates from accidental re-seeding. Items that share a title but have
  // different stage_template_ids are intentional Purchase+Sale pairs and
  // should NOT be touched.
  const groups = new Map();
  for (const m of rows ?? []) {
    if (!m.stage_template_id) continue; // user-added rows have no template id
    const key = m.stage_template_id;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }

  const idsToDelete = [];
  const redirects = []; // { dupId, keptId }
  const patches = []; // { id, patch }

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const kept = group[0];
    const dups = group.slice(1);

    const completedDup =
      dups.find((d) => d.status === COMPLETED) ??
      (kept.status === COMPLETED ? kept : null);
    if (completedDup && kept.status !== COMPLETED) {
      patches.push({
        id: kept.id,
        patch: {
          status: COMPLETED,
          completed_at: completedDup.completed_at ?? new Date().toISOString(),
          email_sent: kept.email_sent || dups.some((d) => d.email_sent),
        },
      });
    }

    for (const d of dups) {
      redirects.push({ dupId: d.id, keptId: kept.id });
      idsToDelete.push(d.id);
    }
  }

  let tasksRelinked = 0;
  if (idsToDelete.length > 0 && !dryRun) {
    for (const p of patches) {
      const { error: patchErr } = await supabase
        .from("milestones")
        .update(p.patch)
        .eq("id", p.id);
      if (patchErr) throw new Error(`patch milestone ${p.id}: ${patchErr.message}`);
    }
    for (const { dupId, keptId } of redirects) {
      const { count, error: relinkErr } = await supabase
        .from("tasks")
        .update({ milestone_id: keptId }, { count: "exact" })
        .eq("milestone_id", dupId);
      if (relinkErr) throw new Error(`relink tasks ${dupId}->${keptId}: ${relinkErr.message}`);
      tasksRelinked += count ?? 0;
    }
    const { error: delErr } = await supabase
      .from("milestones")
      .delete()
      .in("id", idsToDelete);
    if (delErr) throw new Error(`delete milestones: ${delErr.message}`);
  }

  return { removed: idsToDelete.length, tasksRelinked };
}

async function dedupeTasks(dealId) {
  const { data: rows, error } = await supabase
    .from("tasks")
    .select("id, title, status, milestone_id, completed_at, created_at, task_template_id")
    .eq("deal_id", dealId)
    .order("created_at", { ascending: true });

  if (error) throw new Error(`fetch tasks (${dealId}): ${error.message}`);

  // Dedupe by task_template_id — items with the same template id are accidental
  // re-seeds. Items that share a title but have different task_template_ids are
  // intentional Purchase+Sale pairs.
  const groups = new Map();
  for (const t of rows ?? []) {
    if (!t.task_template_id) continue; // user-added tasks have no template id
    const key = t.task_template_id;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  const idsToDelete = [];
  const redirects = [];
  const patches = [];

  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const kept = group[0];
    const dups = group.slice(1);

    const completedDup =
      dups.find((d) => d.status === COMPLETED) ??
      (kept.status === COMPLETED ? kept : null);
    if (completedDup && kept.status !== COMPLETED) {
      patches.push({
        id: kept.id,
        patch: {
          status: COMPLETED,
          completed_at: completedDup.completed_at ?? new Date().toISOString(),
        },
      });
    }

    for (const d of dups) {
      redirects.push({ dupId: d.id, keptId: kept.id });
      idsToDelete.push(d.id);
    }
  }

  let responsesRelinked = 0;
  if (idsToDelete.length > 0 && !dryRun) {
    for (const p of patches) {
      const { error: patchErr } = await supabase
        .from("tasks")
        .update(p.patch)
        .eq("id", p.id);
      if (patchErr) throw new Error(`patch task ${p.id}: ${patchErr.message}`);
    }
    for (const { dupId, keptId } of redirects) {
      const { count, error: relinkErr } = await supabase
        .from("task_responses")
        .update({ task_id: keptId }, { count: "exact" })
        .eq("task_id", dupId);
      if (relinkErr) throw new Error(`relink task_responses ${dupId}->${keptId}: ${relinkErr.message}`);
      responsesRelinked += count ?? 0;
    }
    const { error: delErr } = await supabase
      .from("tasks")
      .delete()
      .in("id", idsToDelete);
    if (delErr) throw new Error(`delete tasks: ${delErr.message}`);
  }

  return { removed: idsToDelete.length, responsesRelinked };
}

async function recalcMilestoneStatuses(dealId) {
  if (dryRun) return;
  const { data: ms } = await supabase
    .from("milestones")
    .select("id, status")
    .eq("deal_id", dealId);
  if (!ms || ms.length === 0) return;

  for (const m of ms) {
    const { data: linked } = await supabase
      .from("tasks")
      .select("status")
      .eq("milestone_id", m.id);
    if (!linked || linked.length === 0) continue;

    const allDone = linked.every((t) => t.status === COMPLETED);
    const anyActive = linked.some(
      (t) => t.status === COMPLETED || t.status === "In Progress",
    );

    let newStatus;
    if (allDone) newStatus = COMPLETED;
    else if (anyActive) newStatus = "In Progress";
    else newStatus = "Pending";

    if (newStatus !== m.status) {
      await supabase
        .from("milestones")
        .update({
          status: newStatus,
          completed_at: newStatus === COMPLETED ? new Date().toISOString() : null,
        })
        .eq("id", m.id);
    }
  }
}

async function run() {
  console.log(`[cleanup] mode: ${dryRun ? "DRY-RUN" : "WRITE"}${onlyDealId ? `, deal=${onlyDealId}` : ""}`);
  const deals = await fetchDeals();
  console.log(`[cleanup] found ${deals.length} combined-type deal(s)`);

  let totalMsRemoved = 0;
  let totalTasksRemoved = 0;
  let totalTasksRelinked = 0;
  let totalResponsesRelinked = 0;

  for (const d of deals) {
    try {
      const ms = await dedupeMilestones(d.id);
      const ts = await dedupeTasks(d.id);
      if (ms.removed > 0 || ts.removed > 0 || ms.tasksRelinked > 0 || ts.responsesRelinked > 0) {
        console.log(
          `  ${d.id}  type="${d.type}"  → milestones removed: ${ms.removed}, tasks relinked: ${ms.tasksRelinked}, tasks removed: ${ts.removed}, responses relinked: ${ts.responsesRelinked}`,
        );
      }
      totalMsRemoved += ms.removed;
      totalTasksRemoved += ts.removed;
      totalTasksRelinked += ms.tasksRelinked;
      totalResponsesRelinked += ts.responsesRelinked;

      await recalcMilestoneStatuses(d.id);
    } catch (err) {
      console.error(`  ${d.id}  ERROR: ${err.message}`);
    }
  }

  console.log(`\n[cleanup] DONE`);
  console.log(`  deals processed:       ${deals.length}`);
  console.log(`  milestones removed:    ${totalMsRemoved}`);
  console.log(`  tasks removed:         ${totalTasksRemoved}`);
  console.log(`  tasks relinked:        ${totalTasksRelinked}`);
  console.log(`  responses relinked:    ${totalResponsesRelinked}`);
  if (dryRun) console.log(`\n  (dry-run — no writes performed)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
