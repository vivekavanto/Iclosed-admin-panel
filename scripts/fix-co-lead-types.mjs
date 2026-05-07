import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const updates = [
  { id: "025a0406-f1a3-4f94-86a8-44a37e0018a5", name: "Pavithra",  newLeadType: "Purchase" },
  { id: "93f744e0-81d5-4f8e-808d-c474152f8c6a", name: "Bharathi",  newLeadType: "Sale" },
];

for (const u of updates) {
  const { data: before } = await supabase
    .from("leads")
    .select("id, first_name, lead_type")
    .eq("id", u.id)
    .single();
  if (!before) {
    console.log(`✗ ${u.name} (${u.id}) not found`);
    continue;
  }
  const { error } = await supabase
    .from("leads")
    .update({ lead_type: u.newLeadType })
    .eq("id", u.id);
  if (error) {
    console.log(`✗ ${u.name}: ${error.message}`);
    continue;
  }
  console.log(`✓ ${u.name}: lead_type "${before.lead_type}" → "${u.newLeadType}"`);
}

// Also update each co-lead's deal type (deals.type mirrors lead_type at conversion).
console.log("\nUpdating linked deal types...");
for (const u of updates) {
  const { data: deals } = await supabase
    .from("deals")
    .select("id, file_number, type")
    .eq("lead_id", u.id);
  for (const d of deals ?? []) {
    const { error } = await supabase
      .from("deals")
      .update({ type: u.newLeadType })
      .eq("id", d.id);
    if (error) {
      console.log(`✗ deal ${d.file_number}: ${error.message}`);
    } else {
      console.log(`✓ deal ${d.file_number}: type "${d.type}" → "${u.newLeadType}"`);
    }
  }
}
