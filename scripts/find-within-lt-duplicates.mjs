import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const lower = (s) => (s ?? "").toLowerCase().trim();

const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type")
  .order("file_number", { ascending: true });

let totalBad = 0;

for (const d of deals ?? []) {
  // milestones grouped by (lead_type, lowercased title)
  const { data: ms } = await supabase
    .from("milestones")
    .select("title, stage_template_id, stage_templates(lead_type)")
    .eq("deal_id", d.id);
  const { data: ts } = await supabase
    .from("tasks")
    .select("title, task_template_id, task_templates(lead_type)")
    .eq("deal_id", d.id);

  const msKeys = new Map();
  for (const m of ms ?? []) {
    const lt = lower(m.stage_templates?.lead_type ?? "");
    const k = `${lt}|${lower(m.title)}`;
    msKeys.set(k, (msKeys.get(k) ?? 0) + 1);
  }
  const tKeys = new Map();
  for (const t of ts ?? []) {
    const lt = lower(t.task_templates?.lead_type ?? "");
    const k = `${lt}|${lower(t.title)}`;
    tKeys.set(k, (tKeys.get(k) ?? 0) + 1);
  }

  const msDup = [...msKeys.entries()].filter(([, c]) => c > 1);
  const tDup = [...tKeys.entries()].filter(([, c]) => c > 1);
  if (msDup.length > 0 || tDup.length > 0) {
    totalBad += 1;
    console.log(`${d.file_number}  type=${d.type}  ms=${ms?.length}  tasks=${ts?.length}`);
    if (msDup.length > 0) console.log(`  ms duplicates within lead_type: ${msDup.map(([k, c]) => k + " x" + c).join(" ; ")}`);
    if (tDup.length > 0) console.log(`  task duplicates within lead_type: ${tDup.map(([k, c]) => k + " x" + c).join(" ; ")}`);
  }
}

console.log(`\nDeals with within-lead-type duplicates: ${totalBad}`);
