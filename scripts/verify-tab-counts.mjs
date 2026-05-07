import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const lower = (s) => (s ?? "").toLowerCase().trim();
const isCombined = (t) => lower(t).includes("purchase") && lower(t).includes("sale");

const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type")
  .order("file_number");
const combined = (deals ?? []).filter((d) => isCombined(d.type));

for (const d of combined) {
  const { data: ms } = await supabase
    .from("milestones")
    .select("title, stage_template_id, stage_templates(lead_type)")
    .eq("deal_id", d.id);
  const { data: ts } = await supabase
    .from("tasks")
    .select("title, task_template_id, task_templates(lead_type)")
    .eq("deal_id", d.id);

  const msByLT = new Map();
  for (const m of ms ?? []) {
    const lt = m.stage_templates?.lead_type ?? "(no template)";
    msByLT.set(lt, (msByLT.get(lt) ?? 0) + 1);
  }
  const tByLT = new Map();
  for (const t of ts ?? []) {
    const lt = t.task_templates?.lead_type ?? "(no template)";
    tByLT.set(lt, (tByLT.get(lt) ?? 0) + 1);
  }

  const fmt = (m) => [...m.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
  console.log(`${d.file_number}  milestones [${fmt(msByLT)}]  tasks [${fmt(tByLT)}]`);
}
