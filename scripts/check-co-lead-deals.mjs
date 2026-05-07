import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const lower = (s) => (s ?? "").toLowerCase().trim();

const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type, lead_id");
for (const d of deals ?? []) {
  const { data: ms } = await supabase.from("milestones").select("title").eq("deal_id", d.id);
  const { data: ts } = await supabase.from("tasks").select("title").eq("deal_id", d.id);
  const msC = new Map();
  for (const m of ms ?? []) msC.set(lower(m.title), (msC.get(lower(m.title)) ?? 0) + 1);
  const tC = new Map();
  for (const t of ts ?? []) tC.set(lower(t.title), (tC.get(lower(t.title)) ?? 0) + 1);
  const msDups = [...msC.entries()].filter(([, c]) => c > 1).length;
  const tDups = [...tC.entries()].filter(([, c]) => c > 1).length;
  if (msDups > 0 || tDups > 0) {
    console.log(`${d.file_number}  type="${d.type}"  ms=${ms?.length}  tasks=${ts?.length}  ⚠ dup-titles: ms=${msDups}, tasks=${tDups}`);
  }
}
