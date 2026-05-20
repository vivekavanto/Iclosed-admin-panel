// One-off backfill for Bharathi R, who was auto-linked to Aliya PRCC's family
// at intake because their purchase addresses match (80 Enterprise Road), but
// Bharathi has his own selling property (6591 Innovator Drive) that doesn't
// belong to Aliya's deal. We split Bharathi's intake into:
//   1) the existing lead/deal — narrowed to Purchase-only, still a co-purchaser
//      on Aliya's family (no sale-side data)
//   2) a NEW Sale-only lead at 6591 Innovator Drive, primary (no parent), which
//      the admin must Convert manually from the UI to create the separate Sale
//      deal. We don't auto-convert from this script because conversion needs
//      milestone/task templating, email dispatch, etc. — already implemented
//      and tested via the admin convert flow.
//
// Existing milestones/tasks on Bharathi's old deal are left alone (deleting
// them risks destroying signed PDFs / completed work). After this runs, an
// admin should review the old deal and clean up any Sale-tagged milestones
// that no longer belong.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://kcrexonvmtzqeuyppegk.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY";
const supabase = createClient(SUPABASE_URL, KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const BHARATHI_LEAD_ID = "9dc397f9-74be-4e76-bb65-b5eb064acdc6";
const DRY_RUN = process.argv.includes("--dry-run");

function log(...args) {
  console.log(DRY_RUN ? "[dry-run]" : "[apply]", ...args);
}

const { data: bharathi, error: fetchErr } = await supabase
  .from("leads")
  .select("*")
  .eq("id", BHARATHI_LEAD_ID)
  .single();

if (fetchErr || !bharathi) {
  console.error("Could not fetch Bharathi's lead:", fetchErr);
  process.exit(1);
}

console.log("Current state:");
console.log(`  name: ${bharathi.first_name} ${bharathi.last_name}`);
console.log(`  email: ${bharathi.email}`);
console.log(`  lead_type: ${bharathi.lead_type}`);
console.log(`  parent_lead_id: ${bharathi.parent_lead_id ?? "(none)"}`);
console.log(`  purchase: ${bharathi.address_street}, ${bharathi.address_city}`);
console.log(`  selling: ${bharathi.selling_address_street ?? "(none)"}, ${bharathi.selling_address_city ?? ""}`);
console.log();

if (!bharathi.selling_address_street) {
  console.log("No selling address — nothing to split. Exiting.");
  process.exit(0);
}

if (bharathi.lead_type !== "Purchase & Sale") {
  console.log(`lead_type is "${bharathi.lead_type}", not "Purchase & Sale". Exiting.`);
  process.exit(0);
}

// Sale-side fields we'll move to the new lead.
const saleFields = {
  address_street: bharathi.selling_address_street,
  address_unit: bharathi.selling_address_unit,
  address_city: bharathi.selling_address_city,
  address_postal_code: bharathi.selling_address_postal_code,
  address_province: bharathi.selling_address_province,
  price: bharathi.selling_price ? String(bharathi.selling_price) : null,
  aps_signed: !!bharathi.aps_signed_sale,
  aps_uploaded: !!bharathi.aps_uploaded_sale,
};

console.log("Step 1: narrow Bharathi's existing lead to Purchase-only");
console.log("  lead_type → Purchase");
console.log("  sub_service → buying");
console.log("  selling_address_* → null");
console.log("  selling_price → null");
console.log("  aps_signed_sale / aps_uploaded_sale → null");
console.log();

if (!DRY_RUN) {
  const { error: updErr } = await supabase
    .from("leads")
    .update({
      lead_type: "Purchase",
      sub_service: "buying",
      selling_address_street: null,
      selling_address_unit: null,
      selling_address_city: null,
      selling_address_postal_code: null,
      selling_address_province: null,
      selling_price: null,
      aps_signed_sale: null,
      aps_uploaded_sale: null,
    })
    .eq("id", BHARATHI_LEAD_ID);
  if (updErr) {
    console.error("  ✗ Lead update failed:", updErr);
    process.exit(1);
  }
  log("  ✓ lead narrowed");
}

console.log();
console.log("Step 2: update Bharathi's existing deal type Purchase & Sale → Purchase");

const { data: existingDeal, error: dealFetchErr } = await supabase
  .from("deals")
  .select("id, type, file_number, property_address, selling_property_address")
  .eq("lead_id", BHARATHI_LEAD_ID)
  .maybeSingle();

if (dealFetchErr) {
  console.error("  ✗ deal fetch failed:", dealFetchErr);
  process.exit(1);
}

if (!existingDeal) {
  console.log("  (no existing deal on this lead — skipping deal update)");
} else {
  console.log(`  existing deal: ${existingDeal.file_number} (${existingDeal.type})`);
  if (existingDeal.type === "Purchase") {
    console.log("  already Purchase, skipping");
  } else if (!DRY_RUN) {
    const { error: dealUpdErr } = await supabase
      .from("deals")
      .update({
        type: "Purchase",
        selling_property_address: null,
        selling_price: null,
      })
      .eq("id", existingDeal.id);
    if (dealUpdErr) {
      console.error("  ✗ deal update failed:", dealUpdErr);
      process.exit(1);
    }
    log(`  ✓ deal ${existingDeal.file_number} updated to Purchase`);
    console.log("  ⚠ Sale-tagged milestones/tasks on this deal are NOT deleted.");
    console.log("    Review them manually in the admin UI.");
  }
}

console.log();
console.log("Step 3: insert new Sale-only lead for 6591 Innovator Drive");
console.log(`  address: ${saleFields.address_street}, ${saleFields.address_city}`);
console.log(`  lead_type: Sale`);
console.log(`  parent_lead_id: null (primary)`);
console.log(`  client_id: ${bharathi.client_id ?? "(none — convertSingleLead will resolve)"}`);
console.log();

// Idempotency: bail out if we've already created the Sale split for this person.
const { data: existingSplit } = await supabase
  .from("leads")
  .select("id")
  .eq("email", bharathi.email)
  .eq("lead_type", "Sale")
  .eq("address_street", saleFields.address_street)
  .is("parent_lead_id", null)
  .eq("is_deleted", false)
  .maybeSingle();

if (existingSplit) {
  console.log(`  ⚠ Sale split already exists (lead id: ${existingSplit.id}). Skipping insert.`);
} else if (!DRY_RUN) {
  const { data: saleLead, error: saleErr } = await supabase
    .from("leads")
    .insert({
      first_name: bharathi.first_name,
      last_name: bharathi.last_name,
      email: bharathi.email,
      phone: bharathi.phone,
      service: bharathi.service ?? "closing",
      sub_service: "selling",
      lead_type: "Sale",
      price: saleFields.price,
      selling_price: null,
      address_street: saleFields.address_street,
      address_unit: saleFields.address_unit,
      address_city: saleFields.address_city,
      address_postal_code: saleFields.address_postal_code,
      address_province: saleFields.address_province,
      selling_address_street: null,
      selling_address_unit: null,
      selling_address_city: null,
      selling_address_postal_code: null,
      selling_address_province: null,
      aps_signed: saleFields.aps_signed,
      aps_uploaded: saleFields.aps_uploaded,
      aps_signed_purchase: null,
      aps_signed_sale: null,
      aps_uploaded_purchase: null,
      aps_uploaded_sale: null,
      co_persons: [],
      referral_source: bharathi.referral_source ?? null,
      client_id: bharathi.client_id ?? null,
      parent_lead_id: null,
      status: "New",
    })
    .select()
    .single();

  if (saleErr) {
    console.error("  ✗ Sale lead insert failed:", saleErr);
    process.exit(1);
  }
  log(`  ✓ New Sale lead created: ${saleLead.id}`);
}

console.log();
console.log("✅ Done. Next step:");
console.log("   Open the admin UI → Leads → find the new Bharathi R Sale lead");
console.log("   at 6591 Innovator Drive → click Convert. That creates the");
console.log("   separate Sale deal for Bharathi's own selling property.");
console.log();
if (DRY_RUN) {
  console.log("(dry-run mode — no changes were applied. Re-run without --dry-run to apply.)");
}
