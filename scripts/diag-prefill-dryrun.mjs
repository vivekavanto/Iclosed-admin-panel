// READ-ONLY dry-run of the auto-prefill logic. Writes NOTHING.
// Finds clients with >=2 deals and shows what person-level responses WOULD be
// copied from the prior deal's Personal Info task into the newest deal.
import { createClient } from "@supabase/supabase-js";
const sb = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);
const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
const isPI = (t) => (t.title ?? "").toLowerCase().includes("personal info");
function isPersonLevel(label) {
  const l = (label ?? "").toLowerCase().trim();
  if (!l) return false;
  if (l.includes("source of funds")) return false;
  if (l.includes("primary residence") || l.includes("investment property")) return false;
  if (l.includes("sign the document") || l.includes("in person or virtually")) return false;
  if (l.includes("ever owned a property")) return false;
  if (l.includes("outside of canada")) return false;
  return l.includes("marital") || l.includes("citizenship") || l.includes("occupation") ||
    ((l.includes("employer") || l.includes("business")) && l.includes("phone")) ||
    l.includes("phone number") || l.includes("street") || l === "city" || l.startsWith("city") ||
    l.includes("postal") || l.includes("province") || l.includes("unit") ||
    l.includes("date of birth") || l === "dob" ||
    l.includes("first name") || l.includes("last name") || l.includes("full name");
}

const { data: deals } = await sb.from("deals").select("id, client_id, lead_id, file_number, created_at");
const byClient = new Map();
for (const d of deals ?? []) { if (!d.client_id) continue; if (!byClient.has(d.client_id)) byClient.set(d.client_id, []); byClient.get(d.client_id).push(d); }
const returning = [...byClient.entries()].filter(([, ds]) => ds.length >= 2);
console.log(`Clients with >=2 deals (returning): ${returning.length}\n`);

let shown = 0;
for (const [clientId, ds] of returning) {
  if (shown >= 5) break;
  ds.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const newest = ds[0];
  const priors = ds.slice(1);

  const { data: newTasks } = await sb.from("tasks").select("id, task_template_id, title").eq("deal_id", newest.id);
  const newPI = (newTasks ?? []).filter(isPI);
  if (newPI.length === 0) continue;

  const priorIds = priors.map((d) => d.id);
  const { data: priorTasks } = await sb.from("tasks").select("id, task_template_id, title, deal_id").in("deal_id", priorIds);
  const dealRank = new Map(priors.map((d, i) => [d.id, i]));
  const priorPI = (priorTasks ?? []).filter((t) => isPI(t) && t.task_template_id)
    .sort((a, b) => (dealRank.get(a.deal_id) ?? 0) - (dealRank.get(b.deal_id) ?? 0));
  const idsByTemplate = new Map();
  for (const t of priorPI) { if (!idsByTemplate.has(t.task_template_id)) idsByTemplate.set(t.task_template_id, []); idsByTemplate.get(t.task_template_id).push(t.id); }

  const allSrc = [...new Set(newPI.flatMap((nt) => nt.task_template_id ? (idsByTemplate.get(nt.task_template_id) ?? []) : []))];
  if (allSrc.length === 0) continue;
  const { data: srcResp } = await sb.from("task_responses").select("task_id, field_id, field_label, value").in("task_id", allSrc);
  const srcByTask = new Map();
  for (const r of srcResp ?? []) { if (!srcByTask.has(r.task_id)) srcByTask.set(r.task_id, []); srcByTask.get(r.task_id).push(r); }

  // Simulate a FRESH new deal: most-recent non-empty person-level value per field.
  const wouldCopy = [], wouldSkip = new Set();
  for (const nt of newPI) {
    if (!nt.task_template_id) continue;
    const chosen = new Map();
    for (const sid of idsByTemplate.get(nt.task_template_id) ?? []) {
      for (const r of srcByTask.get(sid) ?? []) {
        if (isEmpty(r.value)) continue;
        if (!isPersonLevel(r.field_label)) { wouldSkip.add(r.field_label); continue; }
        const fk = r.field_id ?? r.field_label ?? "";
        if (!chosen.has(fk)) chosen.set(fk, r);
      }
    }
    for (const [, r] of chosen) wouldCopy.push(`${r.field_label} = ${r.value}`);
  }

  shown++;
  console.log(`--- client ${clientId} | newest deal ${newest.file_number} ← prior ${priors.map(p=>p.file_number).join(",")} ---`);
  console.log(`  WOULD COPY (person-level): ${wouldCopy.length}`);
  for (const c of wouldCopy) console.log(`     ✓ ${c}`);
  console.log(`  WOULD SKIP (deal-specific): ${[...new Set(wouldSkip)].join(" | ") || "(none)"}`);
  console.log();
}
console.log("Done (read-only dry-run).");
