/**
 * Cleanup within-lead-type duplicates: when a deal has multiple
 * milestones/tasks with the same (lead_type, lowercased title), keep the
 * first by order_index/created_at and delete the rest.
 *
 * Re-links any tasks pointing at a removed duplicate milestone to the
 * surviving milestone, and re-links task_responses pointing at a removed
 * duplicate task to the surviving task. Then recalculates milestones.
 *
 * Run:        node scripts/cleanup-within-leadtype-duplicates.mjs
 * Dry run:    node scripts/cleanup-within-leadtype-duplicates.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const dryRun = process.argv.slice(2).includes("--dry-run");
const lower = (s) => (s ?? "").toLowerCase().trim();
const COMPLETED = "Completed";

const { data: deals } = await supabase.from("deals").select("id, file_number, type");

console.log(`[cleanup-within-lt] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);

let totals = { msRemoved: 0, tsRemoved: 0, tasksRelinked: 0, responsesRelinked: 0 };

for (const deal of deals ?? []) {
  // Fetch milestones with their template lead_type
  const { data: ms } = await supabase
    .from("milestones")
    .select("id, title, status, completed_at, order_index, email_sent, created_at, stage_template_id, stage_templates(lead_type)")
    .eq("deal_id", deal.id)
    .order("order_index", { ascending: true })
    .order("created_at", { ascending: true });

  // Group by (lead_type, lowercased title)
  const msGroups = new Map();
  for (const m of ms ?? []) {
    const lt = lower(m.stage_templates?.lead_type ?? "");
    const key = `${lt}|${lower(m.title)}`;
    if (!key.endsWith("|")) {
      const arr = msGroups.get(key) ?? [];
      arr.push(m);
      msGroups.set(key, arr);
    }
  }

  const msIdRedirect = new Map();
  const msIdsToDelete = [];
  const msPatches = [];
  for (const group of msGroups.values()) {
    if (group.length <= 1) continue;
    const kept = group[0];
    const dups = group.slice(1);

    const completedDup =
      dups.find((d) => d.status === COMPLETED) ??
      (kept.status === COMPLETED ? kept : null);
    if (completedDup && kept.status !== COMPLETED) {
      msPatches.push({
        id: kept.id,
        patch: {
          status: COMPLETED,
          completed_at: completedDup.completed_at ?? new Date().toISOString(),
          email_sent: kept.email_sent || dups.some((d) => d.email_sent),
        },
      });
    }

    for (const d of dups) {
      msIdRedirect.set(d.id, kept.id);
      msIdsToDelete.push(d.id);
    }
  }

  let dealMsRemoved = 0;
  let dealTasksRelinked = 0;
  if (msIdsToDelete.length > 0 && !dryRun) {
    for (const p of msPatches) {
      await supabase.from("milestones").update(p.patch).eq("id", p.id);
    }
    for (const [dupId, keptId] of msIdRedirect.entries()) {
      const { count } = await supabase
        .from("tasks")
        .update({ milestone_id: keptId }, { count: "exact" })
        .eq("milestone_id", dupId);
      dealTasksRelinked += count ?? 0;
    }
    await supabase.from("milestones").delete().in("id", msIdsToDelete);
    dealMsRemoved = msIdsToDelete.length;
  } else if (dryRun) {
    dealMsRemoved = msIdsToDelete.length;
  }

  // Fetch tasks with their template lead_type
  const { data: ts } = await supabase
    .from("tasks")
    .select("id, title, status, milestone_id, completed_at, created_at, task_template_id, task_templates(lead_type)")
    .eq("deal_id", deal.id)
    .order("created_at", { ascending: true });

  const tsGroups = new Map();
  for (const t of ts ?? []) {
    const lt = lower(t.task_templates?.lead_type ?? "");
    const key = `${lt}|${lower(t.title)}`;
    if (!key.endsWith("|")) {
      const arr = tsGroups.get(key) ?? [];
      arr.push(t);
      tsGroups.set(key, arr);
    }
  }

  const tsIdsToDelete = [];
  const tsRedirects = [];
  const tsPatches = [];
  for (const group of tsGroups.values()) {
    if (group.length <= 1) continue;
    const kept = group[0];
    const dups = group.slice(1);

    const completedDup =
      dups.find((d) => d.status === COMPLETED) ??
      (kept.status === COMPLETED ? kept : null);
    if (completedDup && kept.status !== COMPLETED) {
      tsPatches.push({
        id: kept.id,
        patch: {
          status: COMPLETED,
          completed_at: completedDup.completed_at ?? new Date().toISOString(),
        },
      });
    }

    for (const d of dups) {
      tsRedirects.push({ dupId: d.id, keptId: kept.id });
      tsIdsToDelete.push(d.id);
    }
  }

  let dealTsRemoved = 0;
  let dealResponsesRelinked = 0;
  if (tsIdsToDelete.length > 0 && !dryRun) {
    for (const p of tsPatches) {
      await supabase.from("tasks").update(p.patch).eq("id", p.id);
    }
    for (const { dupId, keptId } of tsRedirects) {
      const { count } = await supabase
        .from("task_responses")
        .update({ task_id: keptId }, { count: "exact" })
        .eq("task_id", dupId);
      dealResponsesRelinked += count ?? 0;
    }
    await supabase.from("tasks").delete().in("id", tsIdsToDelete);
    dealTsRemoved = tsIdsToDelete.length;
  } else if (dryRun) {
    dealTsRemoved = tsIdsToDelete.length;
  }

  if (dealMsRemoved > 0 || dealTsRemoved > 0) {
    console.log(
      `${deal.file_number}  type=${deal.type}  -ms:${dealMsRemoved}  -ts:${dealTsRemoved}  relinked tasks:${dealTasksRelinked}  relinked responses:${dealResponsesRelinked}`,
    );
  }

  totals.msRemoved += dealMsRemoved;
  totals.tsRemoved += dealTsRemoved;
  totals.tasksRelinked += dealTasksRelinked;
  totals.responsesRelinked += dealResponsesRelinked;
}

console.log(
  `\n[cleanup-within-lt] DONE — removed ${totals.msRemoved} milestones, ${totals.tsRemoved} tasks, re-linked ${totals.tasksRelinked} tasks, ${totals.responsesRelinked} responses${dryRun ? " (dry-run)" : ""}`,
);
