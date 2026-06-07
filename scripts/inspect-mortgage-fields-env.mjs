import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// Read creds from .env so we hit the SAME project the apps use.
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

const { data: templates, error } = await supabase
  .from("task_templates")
  .select("id, name, lead_type, role_type, is_shared, is_default, is_deleted")
  .ilike("name", "%mortgage%");
if (error) { console.error(error.message); process.exit(1); }

console.log(`Found ${templates?.length ?? 0} task_templates matching %mortgage%:\n`);
for (const t of templates ?? []) {
  console.log(`TEMPLATE ${t.id}`);
  console.log(`  name=${JSON.stringify(t.name)} lead_type=${t.lead_type} role_type=${t.role_type}`);
  const { data: fields } = await supabase
    .from("task_form_fields")
    .select("id, field_type, label, placeholder, required, order_index")
    .eq("task_template_id", t.id)
    .order("order_index", { ascending: true });
  for (const f of fields ?? []) {
    console.log(`    [${f.order_index}] type=${f.field_type} required=${f.required} label=${JSON.stringify(f.label)}`);
  }
  console.log("");
}

const { count } = await supabase
  .from("tasks")
  .select("id", { count: "exact", head: true })
  .ilike("title", "Status of Mortgage");
console.log(`tasks with title ILIKE 'Status of Mortgage': ${count ?? 0}`);
