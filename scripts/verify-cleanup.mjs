import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const dealIds = [
  "3c72944d-5885-450f-8762-5bc7175d3f09",
  "cae18a8b-074c-4818-9a79-d4e0dd38a396",
  "e39a3f9a-a490-42fe-87bc-3f270cb1a34b",
  "e2d4f7be-a92c-4da4-b1ac-518154e62f06",
  "13e63e0b-7d0c-43d3-b3c9-d1fb0b49fe9f",
];

const lower = (s) => (s ?? "").toLowerCase().trim();

for (const dealId of dealIds) {
  const { data: deal } = await supabase
    .from("deals")
    .select("id, file_number, type")
    .eq("id", dealId)
    .single();

  const { data: ms } = await supabase
    .from("milestones")
    .select("id, title, status")
    .eq("deal_id", dealId)
    .order("order_index", { ascending: true });

  const { data: tasks } = await supabase
    .from("tasks")
    .select("id, title, status, milestone_id")
    .eq("deal_id", dealId);

  // Check for duplicates by lowercase title
  const msTitleCounts = new Map();
  for (const m of ms ?? []) {
    const key = lower(m.title);
    msTitleCounts.set(key, (msTitleCounts.get(key) ?? 0) + 1);
  }
  const taskTitleCounts = new Map();
  for (const t of tasks ?? []) {
    const key = lower(t.title);
    taskTitleCounts.set(key, (taskTitleCounts.get(key) ?? 0) + 1);
  }

  const msDups = [...msTitleCounts.entries()].filter(([, c]) => c > 1);
  const taskDups = [...taskTitleCounts.entries()].filter(([, c]) => c > 1);
  const orphanTasks = (tasks ?? []).filter(
    (t) => t.milestone_id && !(ms ?? []).some((m) => m.id === t.milestone_id),
  );

  console.log(
    `${deal?.file_number ?? "?"}  (${dealId.slice(0, 8)}…)  type="${deal?.type}"`,
  );
  console.log(`  milestones: ${ms?.length ?? 0}, duplicates: ${msDups.length}`);
  console.log(`  tasks:      ${tasks?.length ?? 0}, duplicates: ${taskDups.length}`);
  console.log(`  orphan tasks (milestone_id pointing to deleted ms): ${orphanTasks.length}`);
  if (msDups.length > 0) {
    console.log(`  ⚠ duplicate milestone titles:`);
    for (const [t, c] of msDups) console.log(`    "${t}" x ${c}`);
  }
  if (taskDups.length > 0) {
    console.log(`  ⚠ duplicate task titles:`);
    for (const [t, c] of taskDups) console.log(`    "${t}" x ${c}`);
  }
  if (orphanTasks.length > 0) {
    console.log(`  ⚠ orphan task ids: ${orphanTasks.map((t) => t.id.slice(0, 8)).join(", ")}`);
  }
  console.log();
}
