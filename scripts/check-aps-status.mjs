import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const lower = (s) => (s ?? "").toLowerCase().trim();
const isCombined = (t) => lower(t).includes("purchase") && lower(t).includes("sale");

const { data: apsTemplates } = await supabase
  .from("task_templates")
  .select("id, name, lead_type")
  .eq("is_aps_task", true);
console.log("APS templates:");
for (const t of apsTemplates ?? []) console.log(`  [${t.lead_type}] ${t.name}  id=${t.id.slice(0,8)}…`);
const apsIds = (apsTemplates ?? []).map((t) => t.id);

const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type, lead_id");
const combined = (deals ?? []).filter((d) => isCombined(d.type));
console.log(`\nCombined deals & their APS task status:`);

for (const d of combined) {
  const { data: apsTasks } = await supabase
    .from("tasks")
    .select("id, title, status, completed_at, task_template_id, task_templates(lead_type)")
    .eq("deal_id", d.id)
    .in("task_template_id", apsIds);

  console.log(`\n${d.file_number}:`);
  for (const t of apsTasks ?? []) {
    const lt = t.task_templates?.lead_type ?? "?";
    console.log(`  [${lt}] "${t.title}"  status=${t.status}  completed_at=${t.completed_at?.slice(0,19) ?? "—"}`);
  }

  // Also check what was uploaded for this lead
  const { data: docs } = await supabase
    .from("lead_corporate_docs")
    .select("file_name, doc_type, custom_type, created_at")
    .eq("lead_id", d.lead_id);
  if (docs && docs.length > 0) {
    console.log(`  uploads for lead ${d.lead_id.slice(0,8)}…:`);
    for (const doc of docs) console.log(`    type=${doc.doc_type}/${doc.custom_type} file=${doc.file_name}`);
  }
}
