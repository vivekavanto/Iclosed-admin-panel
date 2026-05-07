import { createClient } from "@supabase/supabase-js";
const s = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const dealIds = [
  ["33d0868f-9203-415a-885a-e16283c061c4", "26PS-0009 Sabarish"],
  ["5866af80-4bc8-4b21-9ad0-1870bdc6ab4c", "26P-0044 Pavithra"],
  ["f26b2cfc-91cf-4369-93c7-e96ae5044dad", "26S-0022 Bharathi"],
];
for (const [id, label] of dealIds) {
  const { data: ms } = await s.from("milestones").select("created_at").eq("deal_id", id).order("created_at", { ascending: true });
  const { data: ts } = await s.from("tasks").select("created_at").eq("deal_id", id).order("created_at", { ascending: true });
  const msMin = new Map();
  for (const m of ms ?? []) {
    const k = (m.created_at ?? "").slice(0, 16);
    msMin.set(k, (msMin.get(k) ?? 0) + 1);
  }
  const tsMin = new Map();
  for (const t of ts ?? []) {
    const k = (t.created_at ?? "").slice(0, 16);
    tsMin.set(k, (tsMin.get(k) ?? 0) + 1);
  }
  console.log(`${label}  ms=${ms?.length}  batches=${JSON.stringify([...msMin])}`);
  console.log(`           tasks=${ts?.length}  batches=${JSON.stringify([...tsMin])}\n`);
}
