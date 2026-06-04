// READ-ONLY. Quantify how many clients have marital_status / occupation /
// employer_phone present in their latest Personal Info task responses but
// NULL/empty in the clients row. Splits the count by primary vs co-client.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const empty = (v) => v === null || v === undefined || String(v).trim() === "";

const { data: clients } = await sb.from("clients").select("id, email, first_name, last_name, marital_status, occupation, employer_phone");
const { data: deals } = await sb.from("deals").select("id, client_id, lead_id");
const dealsByClient = new Map();
for (const d of deals ?? []) { if (!dealsByClient.has(d.client_id)) dealsByClient.set(d.client_id, []); dealsByClient.get(d.client_id).push(d); }

// which leads are co-clients (parent_lead_id not null)
const { data: leads } = await sb.from("leads").select("id, parent_lead_id");
const isCoLead = new Map((leads ?? []).map((l) => [l.id, !!l.parent_lead_id]));

const { data: piTasks } = await sb.from("tasks").select("id, deal_id, title");
const piByDeal = new Map();
for (const t of piTasks ?? []) {
  if ((t.title ?? "").toLowerCase().includes("personal info")) {
    if (!piByDeal.has(t.deal_id)) piByDeal.set(t.deal_id, []);
    piByDeal.get(t.deal_id).push(t.id);
  }
}

const { data: resp } = await sb.from("task_responses").select("task_id, field_label, value");
const respByTask = new Map();
for (const r of resp ?? []) { if (!respByTask.has(r.task_id)) respByTask.set(r.task_id, []); respByTask.get(r.task_id).push(r); }

const pick = (rows, pred) => { for (const r of rows) { if (pred((r.field_label ?? "").toLowerCase()) && !empty(r.value)) return r.value; } return null; };

let gapMarital = 0, gapOcc = 0, gapEmp = 0, affectedClients = 0, affectedCo = 0, affectedPrimary = 0;
const examples = [];
for (const c of clients ?? []) {
  const ds = dealsByClient.get(c.id) ?? [];
  let rMarital = null, rOcc = null, rEmp = null, anyCoDeal = false;
  for (const d of ds) {
    if (isCoLead.get(d.lead_id)) anyCoDeal = true;
    for (const tid of piByDeal.get(d.id) ?? []) {
      const rows = respByTask.get(tid) ?? [];
      rMarital ||= pick(rows, (l) => l.includes("marital"));
      rOcc ||= pick(rows, (l) => l.includes("occupation"));
      rEmp ||= pick(rows, (l) => (l.includes("employer") || l.includes("business")) && l.includes("phone"));
    }
  }
  const mMar = rMarital && empty(c.marital_status);
  const mOcc = rOcc && empty(c.occupation);
  const mEmp = rEmp && empty(c.employer_phone);
  if (mMar) gapMarital++;
  if (mOcc) gapOcc++;
  if (mEmp) gapEmp++;
  if (mMar || mOcc || mEmp) {
    affectedClients++;
    if (anyCoDeal) affectedCo++; else affectedPrimary++;
    if (examples.length < 15) examples.push({ name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(), email: c.email, co: anyCoDeal, missMarital: !!mMar, missOcc: !!mOcc, taskMarital: rMarital, taskOcc: rOcc });
  }
}

console.log(`\nTotal clients: ${clients?.length ?? 0}`);
console.log(`Clients with a personal-info value present in task but MISSING in clients row: ${affectedClients}`);
console.log(`  of which co-clients: ${affectedCo}`);
console.log(`  of which primaries:  ${affectedPrimary}`);
console.log(`\nMissing marital_status: ${gapMarital}`);
console.log(`Missing occupation:     ${gapOcc}`);
console.log(`Missing employer_phone: ${gapEmp}`);
console.log(`\n--- examples ---`);
for (const e of examples) console.log(`  ${e.co ? "[co]" : "[primary]"} ${e.name} <${e.email}> missMarital=${e.missMarital}(${e.taskMarital}) missOcc=${e.missOcc}(${e.taskOcc})`);
console.log("\nDone (read-only).\n");
