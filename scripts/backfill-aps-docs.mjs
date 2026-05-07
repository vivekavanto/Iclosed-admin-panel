/**
 * Backfill APS documents from lead_corporate_docs into task_responses for
 * existing converted deals. Matches docs to APS tasks by lead_type:
 *   aps_purchase doc → Purchase APS task
 *   aps_sale doc     → Sale APS task
 *   aps              → all APS tasks
 *   document w/      → all APS tasks (legacy)
 *   custom_type ~APS
 *
 * Run:        node scripts/backfill-aps-docs.mjs
 * Dry run:    node scripts/backfill-aps-docs.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const dryRun = process.argv.slice(2).includes("--dry-run");
const lower = (s) => (s ?? "").toLowerCase().trim();

// 1. Load APS templates with lead_type
const { data: apsTpls } = await supabase
  .from("task_templates")
  .select("id, lead_type")
  .eq("is_aps_task", true)
  .eq("is_deleted", false);
const apsTplLT = new Map((apsTpls ?? []).map((t) => [t.id, lower(t.lead_type)]));
const apsTplIds = (apsTpls ?? []).map((t) => t.id);

// 2. Get every deal that has an APS task
const { data: allApsTasks } = await supabase
  .from("tasks")
  .select("id, deal_id, task_template_id")
  .in("task_template_id", apsTplIds)
  .eq("is_shared", true);

const apsTasksByDeal = new Map();
for (const t of allApsTasks ?? []) {
  if (!apsTasksByDeal.has(t.deal_id)) apsTasksByDeal.set(t.deal_id, []);
  apsTasksByDeal.get(t.deal_id).push(t);
}

console.log(`[backfill-aps] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);
console.log(`[backfill-aps] deals with APS tasks: ${apsTasksByDeal.size}\n`);

let totalBridged = 0;

for (const [dealId, apsTasksOnDeal] of apsTasksByDeal) {
  // 3. Resolve the family lead_ids for this deal
  const { data: deal } = await supabase
    .from("deals")
    .select("file_number, lead_id")
    .eq("id", dealId)
    .single();
  if (!deal?.lead_id) continue;

  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();
  const rootLeadId = leadRow?.parent_lead_id ?? leadRow?.id;
  const { data: familyLeads } = await supabase
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);
  const famIds = (familyLeads ?? []).map((l) => l.id);
  if (famIds.length === 0) continue;

  // 4. Fetch all candidate APS docs for this family
  const { data: docs } = await supabase
    .from("lead_corporate_docs")
    .select("file_name, file_url, doc_type, custom_type")
    .in("lead_id", famIds)
    .or(
      "doc_type.eq.aps_purchase,doc_type.eq.aps_sale,doc_type.eq.aps,doc_type.eq.document,custom_type.ilike.%APS%",
    );
  if (!docs || docs.length === 0) continue;

  const docTargets = (doc) => {
    const dt = lower(doc.doc_type);
    if (dt === "aps_purchase") return new Set(["purchase"]);
    if (dt === "aps_sale") return new Set(["sale"]);
    if (dt === "aps") return new Set(["purchase", "sale"]);
    if (dt === "document" && /aps/i.test(doc.custom_type ?? "")) return new Set(["purchase", "sale"]);
    return new Set();
  };

  let bridgedForDeal = 0;
  for (const task of apsTasksOnDeal) {
    const taskLT = apsTplLT.get(task.task_template_id) ?? "";
    if (!taskLT) continue;

    const matching = docs.filter((d) => docTargets(d).has(taskLT));
    if (matching.length === 0) continue;

    const { data: existing } = await supabase
      .from("task_responses")
      .select("file_name, file_url")
      .eq("task_id", task.id)
      .eq("field_type", "file");
    const existingKeys = new Set(
      (existing ?? []).map((r) => `${r.file_name ?? ""}|${r.file_url ?? ""}`),
    );

    const toInsert = matching
      .filter((d) => d.file_name && !existingKeys.has(`${d.file_name}|${d.file_url ?? ""}`))
      .map((d) => ({
        task_id: task.id,
        field_type: "file",
        field_label: "Upload Agreement of Purchase and Sale",
        file_name: d.file_name,
        file_url: d.file_url,
      }));

    if (toInsert.length > 0) {
      if (!dryRun) {
        const { error } = await supabase.from("task_responses").insert(toInsert);
        if (error) {
          console.error(`  ${deal.file_number} task ${task.id.slice(0, 8)}…: ${error.message}`);
          continue;
        }
      }
      bridgedForDeal += toInsert.length;
    }
  }

  if (bridgedForDeal > 0) {
    console.log(`${deal.file_number}  bridged ${bridgedForDeal} doc(s)`);
    totalBridged += bridgedForDeal;
  }
}

console.log(`\n[backfill-aps] DONE — bridged ${totalBridged} doc(s)${dryRun ? " (dry-run)" : ""}`);
