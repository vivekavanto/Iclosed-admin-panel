import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: parents } = await supabase
  .from("leads")
  .select("id, first_name, last_name")
  .ilike("first_name", "Sabarish")
  .is("parent_lead_id", null);

console.log("matching primaries named Sabarish:");
for (const p of parents ?? []) console.log(`  ${p.id}  ${p.first_name} ${p.last_name}`);

for (const p of parents ?? []) {
  const { data: kids } = await supabase
    .from("leads")
    .select("*")
    .eq("parent_lead_id", p.id);
  if (!kids || kids.length === 0) continue;
  console.log(`\n=== Co-leads under ${p.id} ===`);
  for (const k of kids) {
    console.log(`\n--- ${k.first_name} ${k.last_name} (id=${k.id}) ---`);
    for (const [key, val] of Object.entries(k)) {
      if (val !== null && val !== "" && val !== false) {
        console.log(`  ${key}: ${JSON.stringify(val)}`);
      }
    }
  }
}
