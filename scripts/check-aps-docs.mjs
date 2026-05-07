import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const targets = ["26PS-0009", "26PS-0010", "26PS-0011"];

for (const fn of targets) {
  const { data: deal } = await supabase
    .from("deals")
    .select("id, lead_id")
    .eq("file_number", fn)
    .single();
  if (!deal) continue;

  console.log(`\n=== ${fn} (deal=${deal.id.slice(0,8)}…, lead=${deal.lead_id.slice(0,8)}…) ===`);

  // family lead_ids
  const { data: leadRow } = await supabase
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", deal.lead_id)
    .single();
  const rootLeadId = leadRow?.parent_lead_id ?? leadRow?.id;
  const { data: familyLeads } = await supabase
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);
  const famIds = (familyLeads ?? []).map((l) => l.id);

  // Show docs in lead_corporate_docs
  const { data: docs } = await supabase
    .from("lead_corporate_docs")
    .select("doc_type, custom_type, file_name, file_url, lead_id")
    .in("lead_id", famIds);
  console.log(`  lead_corporate_docs (${docs?.length ?? 0}):`);
  for (const d of docs ?? []) {
    console.log(`    doc_type=${d.doc_type}/${d.custom_type}  file=${d.file_name}  url=${d.file_url ? "YES" : "NO"}`);
  }

  // Show task_responses linked to APS tasks of this deal
  const { data: apsTasks } = await supabase
    .from("tasks")
    .select("id, title, task_template_id, task_templates(lead_type)")
    .eq("deal_id", deal.id);
  const apsRows = (apsTasks ?? []).filter((t) =>
    /agreement of purchase and sale/i.test(t.title ?? ""),
  );
  console.log(`  APS task rows on this deal: ${apsRows.length}`);
  for (const t of apsRows) {
    const lt = t.task_templates?.lead_type ?? "?";
    const { data: resps } = await supabase
      .from("task_responses")
      .select("file_name, file_url, field_type")
      .eq("task_id", t.id);
    console.log(`    [${lt}] task=${t.id.slice(0,8)}…  responses=${resps?.length ?? 0}`);
    for (const r of resps ?? []) {
      console.log(`      file=${r.file_name}  field_type=${r.field_type}`);
    }
  }
}
