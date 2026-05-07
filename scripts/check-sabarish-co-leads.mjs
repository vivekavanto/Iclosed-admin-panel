import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// Find primary Sabarish leads (parent_lead_id null, name ~ Sabarish, type contains Purchase & Sale)
const { data: primaries } = await supabase
  .from("leads")
  .select("id, first_name, last_name, email, lead_type, parent_lead_id, created_at")
  .ilike("first_name", "Sabarish%")
  .is("parent_lead_id", null);

console.log(`Sabarish primaries: ${primaries?.length ?? 0}`);
for (const p of primaries ?? []) {
  console.log(`\nPrimary id=${p.id} email=${p.email}  lead_type="${p.lead_type}"  created=${p.created_at}`);
  const { data: kids } = await supabase
    .from("leads")
    .select("id, first_name, last_name, email, lead_type, created_at")
    .eq("parent_lead_id", p.id);
  for (const k of kids ?? []) {
    console.log(`  co-lead: ${k.first_name} ${k.last_name}  email=${k.email}  lead_type="${k.lead_type}"  id=${k.id}`);
  }
}
