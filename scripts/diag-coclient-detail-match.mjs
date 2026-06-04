// READ-ONLY. For each active co-client lead, find the clients row by email and
// check whether that row actually carries the CO-CLIENT's own name, or someone
// else's (i.e. shares an email with the primary -> collapsed into one row).
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";
const sb = createClient(SUPABASE_URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const norm = (e) => (e ?? "").toLowerCase().trim();
const nm = (a, b) => `${(a ?? "").trim()} ${(b ?? "").trim()}`.trim().toLowerCase();

const { data: clients } = await sb.from("clients").select("id, email, first_name, last_name, converted");
const byEmail = new Map();
for (const c of clients ?? []) { const e = norm(c.email); if (e && !byEmail.has(e)) byEmail.set(e, c); }

const { data: coLeads } = await sb
  .from("leads")
  .select("id, first_name, last_name, email, parent_lead_id, co_person_role, is_deleted");
const active = (coLeads ?? []).filter((l) => l.parent_lead_id && !l.is_deleted);

// Map parent lead id -> parent lead (for shared-email detection)
const leadById = new Map((coLeads ?? []).map((l) => [l.id, l]));
// also need parents (which may be primaries, not in coLeads). Fetch parents.
const parentIds = [...new Set(active.map((l) => l.parent_lead_id))];
const { data: parents } = await sb.from("leads").select("id, first_name, last_name, email").in("id", parentIds);
for (const p of parents ?? []) leadById.set(p.id, p);

let nameMatches = 0, nameMismatch = 0, sharesEmailWithPrimary = 0;
const mismatches = [];
for (const l of active) {
  const e = norm(l.email);
  const row = byEmail.get(e);
  const parent = leadById.get(l.parent_lead_id);
  const sharesParentEmail = parent && norm(parent.email) === e && e;
  if (sharesParentEmail) sharesEmailWithPrimary++;
  if (!row) continue;
  if (nm(row.first_name, row.last_name) === nm(l.first_name, l.last_name)) {
    nameMatches++;
  } else {
    nameMismatch++;
    mismatches.push({
      coName: `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim(),
      role: l.co_person_role ?? "?",
      email: l.email,
      clientsRowName: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim(),
      sharesParentEmail: !!sharesParentEmail,
      parentName: parent ? `${parent.first_name ?? ""} ${parent.last_name ?? ""}`.trim() : "(parent not found)",
    });
  }
}

console.log(`\nActive co-clients: ${active.length}`);
console.log(`  clients row name MATCHES the co-client: ${nameMatches}`);
console.log(`  clients row name is SOMEONE ELSE (co-client details NOT shown): ${nameMismatch}`);
console.log(`  co-clients sharing the SAME email as their primary: ${sharesEmailWithPrimary}`);

if (mismatches.length) {
  console.log(`\n--- co-clients whose details are NOT represented in clients ---`);
  for (const m of mismatches) {
    console.log(`   • co-client: ${m.coName} (${m.role}) <${m.email}>`);
    console.log(`       clients row shows: ${m.clientsRowName}  | sharesPrimaryEmail=${m.sharesParentEmail} | primary=${m.parentName}`);
  }
}
console.log("\nDone (read-only).\n");
