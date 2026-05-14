/**
 * Seed the "Welcome" email template into email_templates so the intake →
 * welcome email flow keeps working after the hardcoded fallback was
 * removed. Content matches the original DEFAULT_WELCOME_BODY exactly so
 * customers receive the same email as before.
 *
 * Idempotent: skips insertion if any template with name LIKE 'welcome%'
 * already exists.
 *
 * Run:  node scripts/seed-welcome-template.mjs
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  "https://kcrexonvmtzqeuyppegk.supabase.co",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjcmV4b252bXR6cWV1eXBwZWdrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDk4NjE5NSwiZXhwIjoyMDg2NTYyMTk1fQ.HWeuZPb724eeR32kbFAsbIahLhm5uuNXbCHazWdMBtY",
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const TEMPLATE_NAME = "Welcome Email";
const TEMPLATE_SUBJECT = "Welcome to iClosed";
const TEMPLATE_BODY = `<p>Hi {{ user.first_name }},</p>

<p>Congratulations on your {{ lead_type }} of {{ lead_address }}.</p>

<p>One of our team members will be reaching out to you shortly to walk you through the next steps.</p>

<p>In the meantime, feel free to explore the resources below to learn more about our services and how we structure our pricing:</p>

<ul>
  <li><a href="https://navawilson.law/title-insurance">Why Do You Need Title Insurance?</a></li>
  <li><a href="https://navawilson.law/transaction-costs">Understanding Real Estate Transaction Costs</a></li>
  <li><a href="https://navawilson.law/disbursements">What Are Disbursements?</a></li>
</ul>

<p>We look forward to connecting with you soon!</p>

<p>Warm regards,</p>
<p>iClosed by Nava Wilson</p>`;

console.log("=== Seed Welcome Email Template ===\n");

// 1. Check for existing welcome-named templates
const { data: existing, error: queryErr } = await supabase
  .from("email_templates")
  .select("id, name, is_active, subject")
  .ilike("name", "welcome%");

if (queryErr) {
  console.error("❌ Failed to query existing templates:", queryErr.message);
  process.exit(1);
}

if (existing && existing.length > 0) {
  console.log(`⚠️  A "welcome" template already exists — skipping insert:`);
  for (const t of existing) {
    console.log(`   • ${t.name}  (id=${t.id}, active=${t.is_active})`);
  }
  console.log(
    "\nIf you want to overwrite, delete the existing row(s) in Supabase first, then re-run.",
  );
  process.exit(0);
}

// 2. Insert the Welcome template
const { data: inserted, error: insertErr } = await supabase
  .from("email_templates")
  .insert({
    name: TEMPLATE_NAME,
    subject: TEMPLATE_SUBJECT,
    body: TEMPLATE_BODY,
    is_active: true,
  })
  .select()
  .single();

if (insertErr) {
  console.error("❌ Failed to insert Welcome template:", insertErr.message);
  process.exit(1);
}

console.log("✅ Welcome template created successfully:\n");
console.log(`   id:        ${inserted.id}`);
console.log(`   name:      ${inserted.name}`);
console.log(`   subject:   ${inserted.subject}`);
console.log(`   is_active: ${inserted.is_active}`);
console.log(`   body:      ${TEMPLATE_BODY.length} chars`);
console.log("\nNext intake submission will now trigger this email automatically.");
