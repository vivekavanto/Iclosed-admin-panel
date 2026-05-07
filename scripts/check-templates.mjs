import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { data: stages } = await supabase
  .from("stage_templates")
  .select("id, name, lead_type, order_index")
  .order("lead_type")
  .order("order_index");

const byType = new Map();
for (const s of stages ?? []) {
  if (!byType.has(s.lead_type)) byType.set(s.lead_type, []);
  byType.get(s.lead_type).push(s);
}

console.log(`Total stage_templates: ${stages?.length ?? 0}`);
for (const [type, list] of byType) {
  console.log(`\n${type} (${list.length}):`);
  for (const s of list) console.log(`  ${s.order_index ?? "?"}: ${s.name}`);
}

// Check name overlaps between Purchase and Sale
const purchaseNames = new Set((byType.get("Purchase") ?? []).map((s) => (s.name ?? "").toLowerCase().trim()));
const saleNames = new Set((byType.get("Sale") ?? []).map((s) => (s.name ?? "").toLowerCase().trim()));
const shared = [...purchaseNames].filter((n) => saleNames.has(n));
const purchaseOnly = [...purchaseNames].filter((n) => !saleNames.has(n));
const saleOnly = [...saleNames].filter((n) => !purchaseNames.has(n));
console.log(`\nName overlap analysis:`);
console.log(`  Shared between Purchase & Sale: ${shared.length}`);
console.log(`  Purchase-only: ${purchaseOnly.length}`);
console.log(`  Sale-only: ${saleOnly.length}`);
console.log(`  Combined unique: ${shared.length + purchaseOnly.length + saleOnly.length}`);
