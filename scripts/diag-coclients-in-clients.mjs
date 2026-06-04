// READ-ONLY diagnostic. Makes NO writes.
// Checks, on the LIVE/prod DB, whether co-purchaser/co-seller leads
// (parent_lead_id IS NOT NULL) have a matching row in public.clients.
import { createClient } from "@supabase/supabase-js";

// LIVE/prod project (same one the backfill-bharathi script targets).
const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";
const sb = createClient(SUPABASE_URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const norm = (e) => (e ?? "").toLowerCase().trim();

// 1. Is the migration applied? (does clients.converted exist?)
const probe = await sb.from("clients").select("id, converted").limit(1);
console.log("\n=== 1. Migration applied? (clients.converted column) ===");
if (probe.error) {
  console.log("  converted column NOT found -> migration likely NOT applied here.");
  console.log("  error:", probe.error.message);
} else {
  console.log("  converted column EXISTS -> clients-hold-all-customers migration IS applied.");
}

// 2. Pull all clients emails
const { data: clients, error: cErr } = await sb.from("clients").select("email, converted");
if (cErr) { console.log("clients read error:", cErr.message); process.exit(1); }
const clientEmails = new Set((clients ?? []).map((c) => norm(c.email)).filter(Boolean));
console.log(`\n=== 2. clients table size ===\n  total client rows: ${clients?.length ?? 0}`);

// 3. Co-client leads (children) that are not deleted
const { data: coLeads, error: lErr } = await sb
  .from("leads")
  .select("id, first_name, last_name, email, parent_lead_id, co_person_role, is_deleted")
  .not("parent_lead_id", "is", null);
if (lErr) { console.log("leads read error:", lErr.message); process.exit(1); }
const active = (coLeads ?? []).filter((l) => !l.is_deleted);

console.log(`\n=== 3. Co-purchaser/co-seller leads (child leads) ===`);
console.log(`  total child leads (incl deleted): ${coLeads?.length ?? 0}`);
console.log(`  active child leads: ${active.length}`);

// 4. Which active co-clients are missing from clients?
const missing = [];
const noEmail = [];
const present = [];
for (const l of active) {
  const e = norm(l.email);
  if (!e) { noEmail.push(l); continue; }
  if (clientEmails.has(e)) present.push(l);
  else missing.push(l);
}

console.log(`\n=== 4. Coverage of active co-clients in clients table ===`);
console.log(`  present in clients: ${present.length}`);
console.log(`  MISSING from clients: ${missing.length}`);
console.log(`  no email (can't sync): ${noEmail.length}`);

if (missing.length) {
  console.log(`\n  --- MISSING co-clients ---`);
  for (const l of missing) {
    console.log(`   • ${l.first_name ?? ""} ${l.last_name ?? ""} | ${l.email} | role=${l.co_person_role ?? "?"} | lead=${l.id}`);
  }
}
if (noEmail.length) {
  console.log(`\n  --- co-clients with NO email ---`);
  for (const l of noEmail) {
    console.log(`   • ${l.first_name ?? ""} ${l.last_name ?? ""} | role=${l.co_person_role ?? "?"} | lead=${l.id}`);
  }
}
console.log("\nDone (read-only).\n");
