import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const log = (label, { data, error }) => {
  if (error) {
    console.error(`  ${label} -> ERROR: ${error.message}`);
    return [];
  }
  console.log(`  ${label} -> ${data?.length ?? 0} row(s)`);
  return data ?? [];
};

// Collect both mortgage templates (old + new name) up front so field updates
// stay scoped no matter which side they sit on.
const { data: templates, error: tErr } = await supabase
  .from("task_templates")
  .select("id, name")
  .or("name.ilike.Status of Mortgage,name.ilike.Mortgage Representative Details");
if (tErr) { console.error(tErr.message); process.exit(1); }
const templateIds = (templates ?? []).map((t) => t.id);
console.log("Mortgage template ids:", templateIds);

console.log("\n1a. Rename Sale template:");
log("task_templates.name", await supabase
  .from("task_templates")
  .update({ name: "Mortgage Representative Details" })
  .ilike("name", "Status of Mortgage")
  .select("id"));

console.log("1b. Rename task rows:");
log("tasks.title", await supabase
  .from("tasks")
  .update({ title: "Mortgage Representative Details" })
  .ilike("title", "Status of Mortgage")
  .select("id"));

console.log("2. Relabel agent name:");
log("task_form_fields", await supabase
  .from("task_form_fields")
  .update({ label: "Mortgage Representative/Agent Name" })
  .eq("label", "Mortgage Agent Name")
  .in("task_template_id", templateIds)
  .select("id"));

console.log("3. Relabel phone:");
log("task_form_fields", await supabase
  .from("task_form_fields")
  .update({ label: "Mortgage Representative/Agent Phone Number" })
  .eq("label", "Phone Number")
  .in("task_template_id", templateIds)
  .select("id"));

console.log("4. Relabel + require email:");
log("task_form_fields", await supabase
  .from("task_form_fields")
  .update({ label: "Mortgage Representative/Agent Email", required: true })
  .eq("label", "Email Address")
  .in("task_template_id", templateIds)
  .select("id"));

console.log("\nDone.");
