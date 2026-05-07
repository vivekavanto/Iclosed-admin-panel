import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const targets = ["26PS-0001", "26PS-0007", "26PS-0008"];

for (const fn of targets) {
  const { data: d } = await supabase
    .from("deals")
    .select("id, file_number, type")
    .eq("file_number", fn)
    .single();
  if (!d) continue;

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, is_shared, task_template_id, milestone_id, task_templates(lead_type)")
    .eq("deal_id", d.id)
    .order("created_at", { ascending: true });

  console.log(`\n=== ${fn} (${d.type}) — ${tasks?.length} tasks ===`);
  for (const t of tasks ?? []) {
    const lt = t.task_templates?.lead_type ?? "?";
    console.log(`  [${lt}] "${t.title}"  shared=${t.is_shared}  ms=${t.milestone_id?.slice(0,8) ?? "null"}  tplId=${t.task_template_id?.slice(0,8) ?? "null"}`);
  }
}
