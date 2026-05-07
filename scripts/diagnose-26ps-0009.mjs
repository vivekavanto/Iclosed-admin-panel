import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: deal } = await supabase
  .from("deals")
  .select("id, file_number, type, lead_id")
  .eq("file_number", "26PS-0009")
  .single();

console.log(`Deal: ${deal.file_number}  id=${deal.id}  lead=${deal.lead_id}`);

const { data: ms } = await supabase
  .from("milestones")
  .select("id, title, stage_template_id, created_at")
  .eq("deal_id", deal.id)
  .order("created_at", { ascending: true });

console.log(`\nTotal milestones: ${ms.length}`);

// Group by stage_template_id
const byTplId = new Map();
for (const m of ms) {
  const k = m.stage_template_id ?? "null";
  if (!byTplId.has(k)) byTplId.set(k, []);
  byTplId.get(k).push(m);
}

const dupTpl = [...byTplId.entries()].filter(([, v]) => v.length > 1);
console.log(`Duplicates by stage_template_id: ${dupTpl.length}`);
for (const [tplId, list] of dupTpl.slice(0, 8)) {
  console.log(`  template ${tplId.slice(0,8)}…: ${list.length} milestones`);
  for (const m of list) console.log(`    "${m.title}"  created=${m.created_at}  id=${m.id.slice(0,8)}`);
}

// Group by created_at minute
const byMin = new Map();
for (const m of ms) {
  const min = (m.created_at ?? "").slice(0, 16);
  byMin.set(min, (byMin.get(min) ?? 0) + 1);
}
console.log(`\nInsertion batches:`);
for (const [min, cnt] of byMin) console.log(`  ${min}: ${cnt} milestones`);

// Also check tasks
const { data: tasks } = await supabase
  .from("tasks")
  .select("id, title, task_template_id, created_at")
  .eq("deal_id", deal.id)
  .order("created_at", { ascending: true });

console.log(`\nTotal tasks: ${tasks.length}`);
const byTaskTpl = new Map();
for (const t of tasks) {
  const k = t.task_template_id ?? "null";
  if (!byTaskTpl.has(k)) byTaskTpl.set(k, []);
  byTaskTpl.get(k).push(t);
}
const dupTaskTpl = [...byTaskTpl.entries()].filter(([, v]) => v.length > 1);
console.log(`Duplicates by task_template_id: ${dupTaskTpl.length}`);
for (const [tplId, list] of dupTaskTpl.slice(0, 5)) {
  console.log(`  template ${tplId.slice(0,8)}…: ${list.length} tasks`);
  for (const t of list) console.log(`    "${t.title}"  created=${t.created_at}`);
}

const byTaskMin = new Map();
for (const t of tasks) {
  const min = (t.created_at ?? "").slice(0, 16);
  byTaskMin.set(min, (byTaskMin.get(min) ?? 0) + 1);
}
console.log(`\nTask insertion batches:`);
for (const [min, cnt] of byTaskMin) console.log(`  ${min}: ${cnt} tasks`);
