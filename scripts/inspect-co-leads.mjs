import { createClient } from "@supabase/supabase-js";
const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";
const supabase = createClient(SUPABASE_URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const { data: primaries } = await supabase
  .from("leads")
  .select("id, first_name, last_name, lead_type, parent_lead_id")
  .ilike("lead_type", "%purchase%sale%")
  .is("parent_lead_id", null);

console.log(`Combined-type primary leads: ${primaries?.length ?? 0}`);
for (const p of primaries ?? []) {
  console.log(`\nPrimary: ${p.first_name} ${p.last_name}  (lead_type="${p.lead_type}")  id=${p.id.slice(0,8)}…`);
  const { data: kids } = await supabase
    .from("leads")
    .select("id, first_name, last_name, lead_type, sub_service")
    .eq("parent_lead_id", p.id);
  if (!kids || kids.length === 0) {
    console.log("  (no co-leads)");
    continue;
  }
  for (const k of kids) {
    console.log(`  co-lead: ${k.first_name} ${k.last_name}  lead_type="${k.lead_type}"  sub_service="${k.sub_service}"  id=${k.id.slice(0,8)}…`);
  }
}
