// READ-ONLY diagnostic for the "Signup email to agents" flow.
// Reproduces every gate in src/lib/sendAgentSignupEmail.ts for a given client
// so we can see exactly WHY the agent email did / didn't send.
//
// Usage:  node scripts/diag-agent-signup-email.mjs <email-or-lead-id>
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

// Read the admin app's real DB + service key from .env.local so this diagnostic
// hits exactly the DB sendAgentSignupEmail uses at runtime.
const env = {};
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
console.log("DB:", env.NEXT_PUBLIC_SUPABASE_URL, "| RESEND_API_KEY set:", !!env.RESEND_API_KEY);

const ARG = process.argv[2];
if (!ARG) {
  console.error("Usage: node scripts/diag-agent-signup-email.mjs <email-or-lead-id>");
  process.exit(1);
}
const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ARG);

const pass = (b) => (b ? "✅ PASS" : "❌ FAIL");

// 1. Resolve the lead
let lead;
if (isUuid) {
  ({ data: lead } = await sb.from("leads").select("*").eq("id", ARG).maybeSingle());
} else {
  ({ data: lead } = await sb
    .from("leads")
    .select("*")
    .ilike("email", ARG)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle());
}

console.log("\n=== LEAD ===");
if (!lead) {
  console.log(`❌ No lead found for "${ARG}". (email lookup is case-insensitive)`);
  process.exit(0);
}
console.log(JSON.stringify({
  id: lead.id,
  email: lead.email,
  first_name: lead.first_name,
  partner_id: lead.partner_id,
  referral_agent_email: lead.referral_agent_email,
  agent_signup_email_sent: lead.agent_signup_email_sent,
}, null, 2));

// Gate 1: column exists?
console.log("\n=== GATE: migration column present ===");
const hasCol = Object.prototype.hasOwnProperty.call(lead, "agent_signup_email_sent");
console.log(pass(hasCol), "leads.agent_signup_email_sent column exists:", hasCol);
if (!hasCol) {
  console.log("   → migration 2026-07-21-lead-agent-signup-email-sent.sql NOT applied to this DB.");
}

// Gate 2: idempotency
console.log("\n=== GATE: idempotency (must be false to send) ===");
console.log(pass(!lead.agent_signup_email_sent), "agent_signup_email_sent =", lead.agent_signup_email_sent);
if (lead.agent_signup_email_sent) {
  console.log("   → Already sent once. Reset with: update leads set agent_signup_email_sent=false where id='" + lead.id + "';");
}

// Gate 3: account activation (a non-Inactive deal)
console.log("\n=== GATE: account activated (>=1 deal with status <> 'Inactive') ===");
const { data: deals } = await sb
  .from("deals")
  .select("file_number, status, client_id")
  .eq("lead_id", lead.id);
console.log("deals for lead:", JSON.stringify(deals, null, 2));
const activated = (deals ?? []).find((d) => d.status && d.status !== "Inactive");
console.log(pass(!!activated), "activated deal:", activated ? `${activated.file_number} (${activated.status})` : "none");

// Gate 4: agent resolves
console.log("\n=== GATE: referral agent resolves ===");
let agentEmail = null;
let agentSource = null;
if (lead.partner_id) {
  const { data: partner } = await sb
    .from("partners")
    .select("agent_email, is_deleted, agent_name")
    .eq("id", lead.partner_id)
    .maybeSingle();
  console.log("partner row:", JSON.stringify(partner, null, 2));
  if (partner && partner.is_deleted) {
    console.log("   ⚠️ partner is soft-deleted (is_deleted=true) → ignored, falling back to free-text.");
  }
  if (partner && !partner.is_deleted && partner.agent_email?.trim()) {
    agentEmail = partner.agent_email.trim();
    agentSource = "partners.agent_email";
  }
}
if (!agentEmail) {
  const freeText = (lead.referral_agent_email ?? "").trim();
  if (freeText) {
    agentEmail = freeText;
    agentSource = "leads.referral_agent_email";
  }
}
console.log(pass(!!agentEmail), "agent email:", agentEmail ?? "NONE", agentSource ? `(from ${agentSource})` : "");

// Gate 5: active "signup" template
console.log("\n=== GATE: active template (name ilike '%signup%') ===");
const { data: templates } = await sb
  .from("email_templates")
  .select("id, name, is_active, subject, body")
  .ilike("name", "%signup%")
  .order("created_at", { ascending: false });
console.log("matching templates:",
  JSON.stringify((templates ?? []).map((t) => ({
    id: t.id, name: t.name, is_active: t.is_active,
    has_body: !!(t.body && t.body.trim()),
  })), null, 2));
const activeTpl = (templates ?? []).find((t) => t.is_active);
const tplOk = !!(activeTpl && activeTpl.body && activeTpl.body.trim());
console.log(pass(tplOk), "usable active template:", activeTpl ? activeTpl.name : "NONE");

// Verdict
console.log("\n=== VERDICT ===");
const wouldSend =
  hasCol &&
  !lead.agent_signup_email_sent &&
  !!activated &&
  !!agentEmail &&
  tplOk;
if (wouldSend) {
  console.log(`✅ All gates pass — sendAgentSignupEmail WOULD send to ${agentEmail}.`);
  console.log("   If it still didn't arrive, the cause is downstream of the gates:");
  console.log("   • the activate-deal webhook was never called by the portal (check admin server logs),");
  console.log("   • RESEND_API_KEY missing in the admin runtime, or");
  console.log("   • Resend rejected/bounced the send (check Resend dashboard).");
} else {
  console.log("❌ At least one gate fails above — that's why no email is sent.");
}
