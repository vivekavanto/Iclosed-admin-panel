/**
 * Normalize any non-combined deal (type Purchase | Sale | Refinance):
 *   1. Remove milestones/tasks whose source template's lead_type differs from
 *      the deal's type. Re-link any orphan tasks to a surviving milestone with
 *      the same title (so progress isn't lost).
 *   2. Within-lead-type dedupe by name (keep first by order).
 *   3. Backfill any missing default templates so the workflow is complete.
 *
 * Run:        node scripts/normalize-single-type-deals.mjs
 * Dry run:    node scripts/normalize-single-type-deals.mjs --dry-run
 * One deal:   node scripts/normalize-single-type-deals.mjs --deal=<uuid>
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dealArg = args.find((a) => a.startsWith("--deal="));
const onlyDealId = dealArg ? dealArg.split("=")[1] : null;

const lower = (s) => (s ?? "").toLowerCase().trim();
const isCombined = (t) => lower(t).includes("purchase") && lower(t).includes("sale");

async function normalizeDeal(deal) {
  const dealId = deal.id;
  const dealType = deal.type;
  const dealTypeLower = lower(dealType);

  // Fetch all relevant templates for the deal's single lead_type
  const { data: stageTemplatesRaw } = await supabase
    .from("stage_templates")
    .select("*")
    .eq("lead_type", dealType)
    .order("order_index", { ascending: true });
  const { data: taskTemplatesRaw } = await supabase
    .from("task_templates")
    .select("*")
    .eq("lead_type", dealType)
    .eq("is_deleted", false)
    .eq("is_default", true)
    .order("order_index", { ascending: true });

  // Within-lead-type dedupe by name (keep first by order_index)
  const dedupeByName = (rows) => {
    const seen = new Set();
    return (rows ?? []).filter((r) => {
      const k = lower(r.name);
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const stageTemplates = dedupeByName(stageTemplatesRaw);
  const taskTemplates = dedupeByName(taskTemplatesRaw);

  // Fetch existing milestones/tasks with template lead_type
  const { data: existingMs } = await supabase
    .from("milestones")
    .select("id, title, stage_template_id, stage_templates(lead_type)")
    .eq("deal_id", dealId);
  const { data: existingTs } = await supabase
    .from("tasks")
    .select("id, title, task_template_id, milestone_id, task_templates(lead_type)")
    .eq("deal_id", dealId);

  // Identify wrong-lead-type rows
  const wrongMs = (existingMs ?? []).filter((m) => {
    const lt = m.stage_templates?.lead_type;
    return lt && lower(lt) !== dealTypeLower;
  });
  const wrongTs = (existingTs ?? []).filter((t) => {
    const lt = t.task_templates?.lead_type;
    return lt && lower(lt) !== dealTypeLower;
  });

  const wrongMsIds = new Set(wrongMs.map((m) => m.id));
  const wrongTsIds = new Set(wrongTs.map((t) => t.id));

  // For each wrong milestone, find a surviving milestone with the same title
  // (case-insensitive) so we can re-link any tasks that were pointing at it.
  const survivingMsByTitle = new Map();
  for (const m of existingMs ?? []) {
    if (!wrongMsIds.has(m.id)) {
      const k = lower(m.title);
      if (k && !survivingMsByTitle.has(k)) survivingMsByTitle.set(k, m.id);
    }
  }

  // Re-link tasks pointing at wrong milestones (only correct-lead-type tasks
  // benefit from re-link; wrong tasks will be deleted anyway)
  let tasksRelinked = 0;
  for (const t of existingTs ?? []) {
    if (wrongTsIds.has(t.id)) continue;
    if (t.milestone_id && wrongMsIds.has(t.milestone_id)) {
      const surviving = survivingMsByTitle.get(lower(t.title)) ?? null;
      if (!dryRun) {
        await supabase
          .from("tasks")
          .update({ milestone_id: surviving })
          .eq("id", t.id);
      }
      tasksRelinked += 1;
    }
  }

  // Delete wrong-lead-type tasks and milestones
  let tasksDeleted = 0;
  let milestonesDeleted = 0;
  if (wrongTsIds.size > 0 && !dryRun) {
    await supabase.from("tasks").delete().in("id", [...wrongTsIds]);
  }
  tasksDeleted = wrongTsIds.size;
  if (wrongMsIds.size > 0 && !dryRun) {
    await supabase.from("milestones").delete().in("id", [...wrongMsIds]);
  }
  milestonesDeleted = wrongMsIds.size;

  // Re-fetch remaining items so backfill works against the post-delete state
  const remainingMsIds = new Set();
  const remainingTsTplIds = new Set();
  const stageToMilestone = new Map();

  if (!dryRun) {
    const { data: remainingMs } = await supabase
      .from("milestones")
      .select("id, stage_template_id")
      .eq("deal_id", dealId);
    const { data: remainingTs } = await supabase
      .from("tasks")
      .select("task_template_id")
      .eq("deal_id", dealId);
    for (const m of remainingMs ?? []) {
      if (m.stage_template_id) {
        remainingMsIds.add(m.stage_template_id);
        stageToMilestone.set(m.stage_template_id, m.id);
      }
    }
    for (const t of remainingTs ?? []) {
      if (t.task_template_id) remainingTsTplIds.add(t.task_template_id);
    }
  } else {
    // Simulate post-delete state for dry-run counting
    for (const m of existingMs ?? []) {
      if (!wrongMsIds.has(m.id) && m.stage_template_id) {
        remainingMsIds.add(m.stage_template_id);
        stageToMilestone.set(m.stage_template_id, m.id);
      }
    }
    for (const t of existingTs ?? []) {
      if (!wrongTsIds.has(t.id) && t.task_template_id) {
        remainingTsTplIds.add(t.task_template_id);
      }
    }
  }

  // Backfill missing milestones
  const missingMsRows = stageTemplates
    .filter((st) => !remainingMsIds.has(st.id))
    .map((st) => ({
      deal_id: dealId,
      title: st.name,
      status: st.auto_complete ? "Completed" : "Pending",
      completed_at: st.auto_complete ? new Date().toISOString() : null,
      order_index: st.order_index,
      email_template_id: st.email_template_id ?? null,
      stage_template_id: st.id,
      description: st.description ?? null,
    }));

  let milestonesAdded = 0;
  if (missingMsRows.length > 0 && !dryRun) {
    const { data: inserted, error } = await supabase
      .from("milestones")
      .insert(missingMsRows)
      .select("id, stage_template_id");
    if (error) throw new Error(`insert ms (${dealId}): ${error.message}`);
    for (const m of inserted ?? []) {
      if (m.stage_template_id) stageToMilestone.set(m.stage_template_id, m.id);
    }
    milestonesAdded = inserted?.length ?? 0;
  } else {
    milestonesAdded = missingMsRows.length;
  }

  // Backfill missing tasks
  const missingTaskRows = taskTemplates
    .filter((tt) => !remainingTsTplIds.has(tt.id))
    .map((tt) => ({
      deal_id: dealId,
      title: tt.name,
      status: "Pending",
      role_type: tt.role_type ?? "Client",
      task_template_id: tt.id,
      is_shared: tt.is_shared ?? false,
      milestone_id: tt.stage_template_id ? (stageToMilestone.get(tt.stage_template_id) ?? null) : null,
    }));

  let tasksAdded = 0;
  if (missingTaskRows.length > 0 && !dryRun) {
    const { error } = await supabase.from("tasks").insert(missingTaskRows);
    if (error) throw new Error(`insert tasks (${dealId}): ${error.message}`);
    tasksAdded = missingTaskRows.length;
  } else {
    tasksAdded = missingTaskRows.length;
  }

  return {
    fileNumber: deal.file_number,
    type: dealType,
    msDeleted: milestonesDeleted,
    tsDeleted: tasksDeleted,
    msAdded: milestonesAdded,
    tsAdded: tasksAdded,
    relinked: tasksRelinked,
  };
}

async function run() {
  console.log(`[normalize] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);

  let q = supabase.from("deals").select("id, file_number, type, created_at");
  if (onlyDealId) q = q.eq("id", onlyDealId);
  const { data: deals } = await q.order("file_number", { ascending: true });

  const targets = (deals ?? []).filter((d) => !isCombined(d.type) && d.type);
  console.log(`[normalize] non-combined deals: ${targets.length}\n`);

  let totals = { msDeleted: 0, tsDeleted: 0, msAdded: 0, tsAdded: 0, relinked: 0 };
  for (const d of targets) {
    try {
      const r = await normalizeDeal(d);
      const changed = r.msDeleted + r.tsDeleted + r.msAdded + r.tsAdded + r.relinked;
      if (changed > 0) {
        console.log(
          `  ${r.fileNumber}  type=${r.type}  -ms:${r.msDeleted} -ts:${r.tsDeleted} +ms:${r.msAdded} +ts:${r.tsAdded} relinked:${r.relinked}`,
        );
      }
      totals.msDeleted += r.msDeleted;
      totals.tsDeleted += r.tsDeleted;
      totals.msAdded += r.msAdded;
      totals.tsAdded += r.tsAdded;
      totals.relinked += r.relinked;
    } catch (err) {
      console.error(`  ${d.file_number}  ERROR: ${err.message}`);
    }
  }
  console.log(
    `\n[normalize] DONE — removed ${totals.msDeleted} ms / ${totals.tsDeleted} tasks, added ${totals.msAdded} ms / ${totals.tsAdded} tasks, re-linked ${totals.relinked}`,
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
