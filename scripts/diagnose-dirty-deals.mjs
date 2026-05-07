import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const dirtyFiles = ["26PS-0005", "26PS-0006"];

for (const fn of dirtyFiles) {
  const { data: d } = await supabase
    .from("deals")
    .select("id, file_number, type, created_at, lead_id, client_id")
    .eq("file_number", fn)
    .single();
  console.log(`\n=== ${fn} ===`);
  console.log(`  deal id: ${d.id}`);
  console.log(`  lead id: ${d.lead_id}`);
  console.log(`  created: ${d.created_at}`);

  const { data: lead } = await supabase
    .from("leads")
    .select("id, first_name, last_name, lead_type, parent_lead_id, status")
    .eq("id", d.lead_id)
    .single();
  console.log(`  lead: ${lead.first_name} ${lead.last_name}  lead_type="${lead.lead_type}"  parent=${lead.parent_lead_id ?? "(none)"}  status="${lead.status}"`);

  // Look at the milestones grouped to see the pattern of x2/x3
  const { data: ms } = await supabase
    .from("milestones")
    .select("id, title, stage_template_id, created_at, order_index")
    .eq("deal_id", d.id)
    .order("created_at", { ascending: true });

  console.log(`  milestones (${ms.length}):`);
  // group by created_at minute to spot bulk-insert batches
  const byMinute = new Map();
  for (const m of ms) {
    const minute = (m.created_at ?? "").slice(0, 16);
    byMinute.set(minute, (byMinute.get(minute) ?? 0) + 1);
  }
  for (const [min, cnt] of byMinute) console.log(`    ${min}: ${cnt} milestones`);

  // also count per stage_template_id
  const stCounts = new Map();
  for (const m of ms) {
    const k = m.stage_template_id ?? "null";
    stCounts.set(k, (stCounts.get(k) ?? 0) + 1);
  }
  const dupStages = [...stCounts.entries()].filter(([, c]) => c > 1);
  if (dupStages.length > 0) {
    console.log(`  ⚠ duplicates by stage_template_id: ${dupStages.length}`);
    for (const [k, c] of dupStages.slice(0, 5)) console.log(`    template ${k.slice(0,8)}…: ${c} milestones`);
  }
}
