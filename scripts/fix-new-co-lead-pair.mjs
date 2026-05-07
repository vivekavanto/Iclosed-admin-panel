import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const updates = [
  { id: "da0b1ac3-e174-4e1d-979b-f3fcfc53f72e", name: "Pavithra (new)", newLeadType: "Purchase" },
  { id: "ba4b5f36-175b-4b55-8a27-2663f2229e1d", name: "Bharathi (new)", newLeadType: "Sale" },
];

for (const u of updates) {
  const { data: before } = await supabase
    .from("leads")
    .select("id, first_name, lead_type")
    .eq("id", u.id)
    .single();
  if (!before) {
    console.log(`✗ ${u.name} not found`);
    continue;
  }
  const { error } = await supabase
    .from("leads")
    .update({ lead_type: u.newLeadType })
    .eq("id", u.id);
  console.log(error ? `✗ ${u.name}: ${error.message}` : `✓ ${u.name}: "${before.lead_type}" → "${u.newLeadType}"`);
}
