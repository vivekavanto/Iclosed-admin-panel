import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Read creds from .env so we hit the SAME project the apps use (dev).
const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
console.log("Connecting to:", url, "\n");

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const log = (label, { data, error }) => {
  if (error) { console.error(`  ${label} -> ERROR: ${error.message}`); return []; }
  console.log(`  ${label} -> ${data?.length ?? 0} row(s)`);
  return data ?? [];
};

// Identify the mortgage task templates by their current name. Dev uses
// "Mortgage Details"; also tolerate the old/new names so this is portable.
const { data: templates, error: tErr } = await supabase
  .from("task_templates")
  .select("id, name")
  .ilike("name", "%mortgage%");
if (tErr) { console.error(tErr.message); process.exit(1); }
const templateIds = (templates ?? []).map((t) => t.id);
console.log("Mortgage template ids:", templateIds, "names:", (templates ?? []).map((t) => t.name));

console.log("\n1a. Rename templates -> Mortgage Representative Details:");
log("task_templates.name", await supabase
  .from("task_templates").update({ name: "Mortgage Representative Details" })
  .in("id", templateIds).select("id"));

console.log("1b. Rename task rows (scoped by template id):");
log("tasks.title", await supabase
  .from("tasks").update({ title: "Mortgage Representative Details" })
  .in("task_template_id", templateIds).select("id"));

console.log("2. Relabel agent name:");
log("task_form_fields", await supabase
  .from("task_form_fields").update({ label: "Mortgage Representative/Agent Name" })
  .eq("label", "Mortgage Agent Name").in("task_template_id", templateIds).select("id"));

console.log("3. Relabel phone:");
log("task_form_fields", await supabase
  .from("task_form_fields").update({ label: "Mortgage Representative/Agent Phone Number" })
  .eq("label", "Phone Number").in("task_template_id", templateIds).select("id"));

console.log("4. Relabel + require email:");
log("task_form_fields", await supabase
  .from("task_form_fields").update({ label: "Mortgage Representative/Agent Email", required: true })
  .eq("label", "Email Address").in("task_template_id", templateIds).select("id"));

console.log("\n========= VERIFY =========");
const { data: after } = await supabase
  .from("task_templates").select("id, name, lead_type").ilike("name", "%mortgage%");
for (const t of after ?? []) {
  console.log(`\nTEMPLATE ${t.id} name=${JSON.stringify(t.name)} lead_type=${t.lead_type}`);
  const { data: fields } = await supabase
    .from("task_form_fields")
    .select("field_type, label, required, order_index")
    .eq("task_template_id", t.id).order("order_index", { ascending: true });
  for (const f of fields ?? [])
    console.log(`    [${f.order_index}] ${f.field_type} required=${f.required} ${JSON.stringify(f.label)}`);
}
const { count } = await supabase
  .from("tasks").select("id", { count: "exact", head: true }).in("task_template_id", templateIds);
console.log(`\ntasks now titled 'Mortgage Representative Details' (by template): ${count ?? 0}`);
