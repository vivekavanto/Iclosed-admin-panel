import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const lower = (s) => (s ?? "").toLowerCase().trim();

const { data: deals } = await supabase
  .from("deals")
  .select("id, file_number, type, created_at, lead_id")
  .order("created_at", { ascending: false });

const combined = (deals ?? []).filter((d) => {
  const t = lower(d.type);
  return t.includes("purchase") && t.includes("sale");
});

console.log(`Combined-type deals: ${combined.length}\n`);

for (const d of combined) {
  const { data: ms } = await supabase
    .from("milestones")
    .select("id, title")
    .eq("deal_id", d.id);
  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title")
    .eq("deal_id", d.id);

  const msCounts = new Map();
  for (const m of ms ?? []) {
    const k = lower(m.title);
    msCounts.set(k, (msCounts.get(k) ?? 0) + 1);
  }
  const tCounts = new Map();
  for (const t of tasks ?? []) {
    const k = lower(t.title);
    tCounts.set(k, (tCounts.get(k) ?? 0) + 1);
  }
  const msDups = [...msCounts.entries()].filter(([, c]) => c > 1);
  const tDups = [...tCounts.entries()].filter(([, c]) => c > 1);

  const flag = msDups.length > 0 || tDups.length > 0 ? " ⚠ DUPLICATES" : "";
  console.log(
    `${d.file_number}  type="${d.type}"  ms=${ms?.length ?? 0}  tasks=${tasks?.length ?? 0}  created=${d.created_at?.slice(0, 19)}${flag}`,
  );
  if (msDups.length > 0) {
    console.log(`    duplicate milestone titles:`);
    for (const [t, c] of msDups) console.log(`      "${t}" x${c}`);
  }
  if (tDups.length > 0) {
    console.log(`    duplicate task titles:`);
    for (const [t, c] of tDups) console.log(`      "${t}" x${c}`);
  }
}
