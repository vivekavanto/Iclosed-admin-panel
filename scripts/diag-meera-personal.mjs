// READ-ONLY. Inspect whether a co-client's personal details are synced to clients.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const EMAIL = "mselvakone@gmail.com";

const { data: client } = await sb.from("clients").select("*").ilike("email", EMAIL).single();
console.log("\n=== clients row (full) ===");
console.log(JSON.stringify(client, null, 2));

const { data: lead } = await sb.from("leads").select("*").ilike("email", EMAIL).single();
console.log("\n=== lead: personal fields + client_id ===");
console.log(JSON.stringify({
  id: lead?.id, client_id: lead?.client_id, parent_lead_id: lead?.parent_lead_id,
  marital_status: lead?.marital_status, citizenship_status: lead?.citizenship_status,
  occupation: lead?.occupation, employer_phone: lead?.employer_phone,
  is_corporate: lead?.is_corporate, corporate_name: lead?.corporate_name,
}, null, 2));

// Her deal(s) and whether client_id matches her client row
const { data: deals } = await sb.from("deals").select("id, lead_id, client_id, file_number, type").eq("lead_id", lead?.id);
console.log("\n=== her deal(s) ===");
console.log(JSON.stringify(deals, null, 2));
console.log("client row id =", client?.id, " | deal.client_id matches?", deals?.map(d => d.client_id === client?.id));

// Personal Info task(s) on her deal + responses
for (const d of deals ?? []) {
  const { data: tasks } = await sb.from("tasks").select("id, title, deal_id").eq("deal_id", d.id);
  const piTasks = (tasks ?? []).filter(t => (t.title ?? "").toLowerCase().includes("personal info"));
  console.log(`\n=== deal ${d.file_number}: personal-info tasks ===`);
  console.log(JSON.stringify(piTasks, null, 2));
  for (const t of piTasks) {
    const { data: resp } = await sb.from("task_responses").select("field_label, value").eq("task_id", t.id);
    console.log(`  responses for task ${t.id}:`);
    console.log(JSON.stringify(resp, null, 2));
  }
}
console.log("\nDone (read-only).\n");
