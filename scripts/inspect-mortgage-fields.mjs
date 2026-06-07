import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: templates, error: tErr } = await supabase
  .from("task_templates")
  .select("id, name, lead_type, role_type, is_shared, is_default, is_deleted, stage_template_id")
  .ilike("name", "%mortgage%");

if (tErr) {
  console.error("template error:", tErr.message);
  process.exit(1);
}

console.log(`Found ${templates?.length ?? 0} task_templates matching %mortgage%:\n`);
for (const t of templates ?? []) {
  console.log(`TEMPLATE ${t.id}`);
  console.log(`  name=${JSON.stringify(t.name)} lead_type=${t.lead_type} role_type=${t.role_type} is_shared=${t.is_shared} is_default=${t.is_default} is_deleted=${t.is_deleted}`);

  const { data: fields } = await supabase
    .from("task_form_fields")
    .select("id, field_type, label, placeholder, required, order_index, options")
    .eq("task_template_id", t.id)
    .order("order_index", { ascending: true });

  for (const f of fields ?? []) {
    console.log(`    [${f.order_index}] type=${f.field_type} required=${f.required} label=${JSON.stringify(f.label)} placeholder=${JSON.stringify(f.placeholder)} options=${JSON.stringify(f.options)}`);
  }
  console.log("");
}

// Also count tasks with this title across deals
const { count: taskCount } = await supabase
  .from("tasks")
  .select("id", { count: "exact", head: true })
  .ilike("title", "Status of Mortgage");
console.log(`tasks with title ILIKE 'Status of Mortgage': ${taskCount ?? 0}`);
