/**
 * Backfill — for existing combined-type deals (e.g. "Purchase & Sale") that
 * had their Sale-tagged milestones/tasks removed by the earlier cleanup,
 * re-seed any missing templates so each lead_type's workflow is complete.
 *
 * Within-lead-type dedupe by name is applied (one row per unique title per
 * lead_type) — matches the new convertLead.ts behavior.
 *
 * Run with:    node scripts/backfill-combined-templates.mjs
 * Dry run:     node scripts/backfill-combined-templates.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const dryRun = process.argv.slice(2).includes("--dry-run");
const lower = (s) => (s ?? "").toLowerCase().trim();

function splitLeadType(type) {
  return (type ?? "")
    .split(/\s*(?:&|\band\b|\+|\/)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function backfillDeal(deal) {
  const dealId = deal.id;
  const leadTypeParts = splitLeadType(deal.type);
  if (leadTypeParts.length < 2) return { dealId, milestonesAdded: 0, tasksAdded: 0 };

  // Fetch all relevant templates
  const { data: stageTemplatesRaw } = await supabase
    .from("stage_templates")
    .select("*")
    .in("lead_type", leadTypeParts)
    .order("order_index", { ascending: true });

  const { data: taskTemplatesRaw } = await supabase
    .from("task_templates")
    .select("*")
    .in("lead_type", leadTypeParts)
    .eq("is_deleted", false)
    .eq("is_default", true)
    .order("order_index", { ascending: true });

  // Within-lead-type dedupe by name (match new convertLead.ts behavior)
  const dedupeWithinLeadType = (rows) => {
    const seenByLT = new Map();
    return (rows ?? []).filter((r) => {
      const lt = lower(r.lead_type);
      const key = lower(r.name);
      if (!key) return true;
      if (!seenByLT.has(lt)) seenByLT.set(lt, new Set());
      const seen = seenByLT.get(lt);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const stageTemplates = dedupeWithinLeadType(stageTemplatesRaw);
  const taskTemplates = dedupeWithinLeadType(taskTemplatesRaw);

  // Existing milestones/tasks on the deal
  const { data: existingMs } = await supabase
    .from("milestones")
    .select("id, stage_template_id")
    .eq("deal_id", dealId);
  const { data: existingTs } = await supabase
    .from("tasks")
    .select("id, task_template_id")
    .eq("deal_id", dealId);

  const existingStageIds = new Set((existingMs ?? []).map((m) => m.stage_template_id).filter(Boolean));
  const existingTaskTplIds = new Set((existingTs ?? []).map((t) => t.task_template_id).filter(Boolean));

  // Build stageToMilestone map (existing + new)
  const stageToMilestone = new Map();
  for (const m of existingMs ?? []) {
    if (m.stage_template_id) stageToMilestone.set(m.stage_template_id, m.id);
  }

  // Determine missing milestones
  const missingStageRows = stageTemplates
    .filter((st) => !existingStageIds.has(st.id))
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
  if (missingStageRows.length > 0 && !dryRun) {
    const { data: inserted, error } = await supabase
      .from("milestones")
      .insert(missingStageRows)
      .select("id, stage_template_id");
    if (error) throw new Error(`insert milestones (${dealId}): ${error.message}`);
    for (const ms of inserted ?? []) {
      if (ms.stage_template_id) stageToMilestone.set(ms.stage_template_id, ms.id);
    }
    milestonesAdded = inserted?.length ?? 0;
  } else if (dryRun) {
    milestonesAdded = missingStageRows.length;
  }

  // Determine missing tasks (link to milestone via stage_template_id)
  const missingTaskRows = taskTemplates
    .filter((tt) => !existingTaskTplIds.has(tt.id))
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
    const { data: inserted, error } = await supabase
      .from("tasks")
      .insert(missingTaskRows)
      .select("id");
    if (error) throw new Error(`insert tasks (${dealId}): ${error.message}`);
    tasksAdded = inserted?.length ?? 0;
  } else if (dryRun) {
    tasksAdded = missingTaskRows.length;
  }

  return { dealId, fileNumber: deal.file_number, milestonesAdded, tasksAdded };
}

async function run() {
  console.log(`[backfill] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);

  const { data: deals } = await supabase
    .from("deals")
    .select("id, file_number, type, created_at")
    .order("created_at", { ascending: true });

  const combined = (deals ?? []).filter((d) => {
    const t = lower(d.type);
    return t.includes("purchase") && t.includes("sale");
  });

  console.log(`[backfill] combined deals: ${combined.length}\n`);

  let totalMs = 0;
  let totalT = 0;
  for (const d of combined) {
    try {
      const r = await backfillDeal(d);
      console.log(`  ${r.fileNumber}  +${r.milestonesAdded} milestones  +${r.tasksAdded} tasks`);
      totalMs += r.milestonesAdded;
      totalT += r.tasksAdded;
    } catch (err) {
      console.error(`  ${d.file_number}  ERROR: ${err.message}`);
    }
  }
  console.log(`\n[backfill] DONE — added ${totalMs} milestones, ${totalT} tasks`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
