/**
 * Fix APS task completion: for each combined Purchase & Sale deal, determine
 * which side(s) were actually uploaded (via lead_corporate_docs.doc_type =
 * 'aps_purchase' or 'aps_sale'), then revert any APS task to Pending whose
 * lead_type wasn't actually uploaded.
 *
 * Also propagates across the family (primary + co-leads).
 *
 * Run:        node scripts/fix-aps-completion.mjs
 * Dry run:    node scripts/fix-aps-completion.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const dryRun = process.argv.slice(2).includes("--dry-run");
const lower = (s) => (s ?? "").toLowerCase().trim();
const isCombined = (t) => lower(t).includes("purchase") && lower(t).includes("sale");

// Load APS templates with their lead_type
const { data: apsTpls } = await supabase
  .from("task_templates")
  .select("id, lead_type")
  .eq("is_aps_task", true)
  .eq("is_deleted", false);
const apsTplLT = new Map(
  (apsTpls ?? []).map((t) => [t.id, lower(t.lead_type)]),
);
const apsTplIds = (apsTpls ?? []).map((t) => t.id);

// Find every combined deal
const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type, lead_id");
const combinedDeals = (deals ?? []).filter((d) => isCombined(d.type));

console.log(`[fix-aps] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);
console.log(`[fix-aps] combined deals: ${combinedDeals.length}\n`);

let totalReverted = 0;

for (const deal of combinedDeals) {
  // 1. Find the lead's family (primary + co-leads)
  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();
  if (!leadRow) continue;
  const rootLeadId = leadRow.parent_lead_id ?? leadRow.id;
  const { data: familyLeads } = await supabase
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);
  const familyLeadIds = (familyLeads ?? []).map((l) => l.id);

  // 2. Determine which sides were actually uploaded (across the family)
  const { data: docs } = await supabase
    .from("lead_corporate_docs")
    .select("doc_type, lead_id")
    .in("lead_id", familyLeadIds);
  const uploadedSides = new Set();
  for (const d of docs ?? []) {
    const t = lower(d.doc_type);
    if (t === "aps_purchase") uploadedSides.add("purchase");
    else if (t === "aps_sale") uploadedSides.add("sale");
  }

  // 3. Find every family deal
  const { data: familyDeals } = await supabase
    .from("deals")
    .select("id")
    .in("lead_id", familyLeadIds);
  const familyDealIds = (familyDeals ?? []).map((d) => d.id);

  // 4. Find all APS tasks across the family
  const { data: apsTasks } = await supabase
    .from("tasks")
    .select("id, deal_id, status, task_template_id")
    .in("deal_id", familyDealIds)
    .in("task_template_id", apsTplIds);

  // 5. Decide which to revert: status=Completed AND template lead_type NOT in uploadedSides
  const toRevert = (apsTasks ?? []).filter((t) => {
    if (t.status !== "Completed") return false;
    const lt = apsTplLT.get(t.task_template_id) ?? "";
    if (!lt) return false;
    return !uploadedSides.has(lt);
  });

  if (toRevert.length === 0) continue;

  console.log(
    `${deal.file_number}  uploaded=[${[...uploadedSides].join(", ") || "(none)"}]  reverting ${toRevert.length} APS task(s)`,
  );

  if (!dryRun) {
    await supabase
      .from("tasks")
      .update({ status: "Pending", completed: false, completed_at: null })
      .in("id", toRevert.map((t) => t.id));

    // Also revert any milestones whose status is "Completed" but whose tasks
    // are all now non-completed: skip — recalcMilestones at runtime handles
    // milestone status based on linked tasks.
  }

  totalReverted += toRevert.length;
}

console.log(`\n[fix-aps] DONE — reverted ${totalReverted} APS task(s)${dryRun ? " (dry-run)" : ""}`);
