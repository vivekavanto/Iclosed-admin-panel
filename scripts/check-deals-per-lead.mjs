import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const leadIds = ["3d868309-beb3-4b80-90d2-7917ee68a986", "d69634ad-fdc7-4515-9e49-786dc130c826"];

for (const lid of leadIds) {
  const { data: deals } = await supabase
    .from("deals")
    .select("id, file_number, type, created_at, lead_id")
    .eq("lead_id", lid)
    .order("created_at", { ascending: true });
  console.log(`\nlead ${lid.slice(0,8)}…  (${deals?.length ?? 0} deals)`);
  for (const d of deals ?? []) {
    console.log(`  ${d.file_number}  ${d.id}  type=${d.type}  created=${d.created_at}`);
  }
}

console.log("\n--- Looking for any deal whose milestones span multiple created_at minutes ---");
const { data: allMilestones } = await supabase
  .from("milestones")
  .select("deal_id, created_at");

const byDeal = new Map();
for (const m of allMilestones ?? []) {
  const minute = (m.created_at ?? "").slice(0, 16);
  if (!byDeal.has(m.deal_id)) byDeal.set(m.deal_id, new Set());
  byDeal.get(m.deal_id).add(minute);
}

const multiBatch = [...byDeal.entries()].filter(([, s]) => s.size > 1);
console.log(`Deals with milestones inserted in multiple batches: ${multiBatch.length}`);
for (const [did, mins] of multiBatch.slice(0, 10)) {
  console.log(`  ${did.slice(0,8)}…  batches: ${[...mins].join(", ")}`);
}
