/**
 * One-shot rename — converts existing combined-type ("Purchase & Sale") deals'
 * file numbers from {YY}P-NNNN (the old prefix) to {YY}PS-NNNN. Runs per year
 * so the sequence is independent of pure-Purchase numbering.
 *
 * Run with:    node scripts/renumber-combined-deals.mjs
 * Dry run:     node scripts/renumber-combined-deals.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";

const dryRun = process.argv.slice(2).includes("--dry-run");

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const isCombinedType = (type) => {
  const t = (type ?? "").toLowerCase();
  return t.includes("purchase") && t.includes("sale");
};

// Extract the 2-digit year prefix from an existing file number like "26P-0037"
// or fall back to the created_at year.
function yearPrefixFor(deal) {
  const fn = deal.file_number ?? "";
  const m = fn.match(/^(\d{2})/);
  if (m) return m[1];
  if (deal.created_at) {
    const y = new Date(deal.created_at).getFullYear().toString().slice(-2);
    return y;
  }
  return new Date().getFullYear().toString().slice(-2);
}

async function maxExistingPsNumber(yearPrefix) {
  const prefix = `${yearPrefix}PS-`;
  const { data, error } = await supabase
    .from("deals")
    .select("file_number")
    .like("file_number", `${prefix}%`);
  if (error) throw new Error(`fetch existing PS deals: ${error.message}`);

  let max = 0;
  for (const d of data ?? []) {
    const suffix = (d.file_number ?? "").replace(prefix, "");
    if (!/^\d+$/.test(suffix)) continue;
    const n = parseInt(suffix, 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

async function run() {
  console.log(`[renumber] mode: ${dryRun ? "DRY-RUN" : "WRITE"}`);

  // Fetch all combined deals, oldest first so they get the lowest sequence
  // numbers within each year.
  const { data: deals, error } = await supabase
    .from("deals")
    .select("id, file_number, type, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`fetch deals: ${error.message}`);

  const combined = (deals ?? []).filter((d) => isCombinedType(d.type));
  // Skip deals already on the PS prefix
  const needsRename = combined.filter((d) => !/^\d{2}PS-/.test(d.file_number ?? ""));

  console.log(`[renumber] combined deals: ${combined.length}`);
  console.log(`[renumber] needing rename: ${needsRename.length}`);

  if (needsRename.length === 0) {
    console.log("[renumber] nothing to do.");
    return;
  }

  // Group by year prefix
  const byYear = new Map();
  for (const d of needsRename) {
    const y = yearPrefixFor(d);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(d);
  }

  const planned = [];
  for (const [year, list] of byYear) {
    const startFrom = (await maxExistingPsNumber(year)) + 1;
    list.forEach((deal, idx) => {
      const newFn = `${year}PS-${String(startFrom + idx).padStart(4, "0")}`;
      planned.push({ deal, newFn });
    });
  }

  console.log(`\nPlanned changes (${planned.length}):`);
  for (const { deal, newFn } of planned) {
    console.log(`  ${deal.file_number}  →  ${newFn}   (${deal.id.slice(0, 8)}…)`);
  }

  if (dryRun) {
    console.log(`\n(dry-run — no writes performed)`);
    return;
  }

  // Apply updates one at a time. Defensive: skip if the target number already
  // exists (shouldn't happen given startFrom logic, but safety first).
  let updated = 0;
  for (const { deal, newFn } of planned) {
    const { data: existing } = await supabase
      .from("deals")
      .select("id")
      .eq("file_number", newFn)
      .maybeSingle();
    if (existing) {
      console.log(`  ⚠ skipping ${deal.file_number}: target ${newFn} already in use`);
      continue;
    }
    const { error: updateErr } = await supabase
      .from("deals")
      .update({ file_number: newFn })
      .eq("id", deal.id);
    if (updateErr) {
      console.error(`  ✗ ${deal.file_number} → ${newFn}: ${updateErr.message}`);
      continue;
    }
    console.log(`  ✓ ${deal.file_number} → ${newFn}`);
    updated += 1;
  }

  console.log(`\n[renumber] DONE — ${updated}/${planned.length} updated`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
