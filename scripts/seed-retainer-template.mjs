/**
 * Seed/refresh the "Sign Retainer" email template in email_templates so the
 * retainer-first conversion flow uses a DB-managed, admin-editable email
 * (the hardcoded defaultRetainerEmail() fallback was removed from
 * src/lib/sendRetainerLink.ts).
 *
 * sendRetainerLinkEmail() finds it via findRetainerLinkTemplate(): an ACTIVE
 * template named one of "Sign Retainer" / "Sign Your Retainer" / "Retainer
 * Signing" / "Review and Sign Retainer" (excluding any name containing
 * "signed", which is the post-sign confirmation template).
 *
 * Link placeholder {{ confirmation_url }} → renderTemplate() maps it to the
 * signing URL. Styling mirrors the existing "Activate my account" invite email
 * (brand red #DC2626, 600px container, logo footer).
 *
 * UPSERT: updates the existing "Sign Retainer" row if present, else inserts.
 * Reads creds from .env.local so it targets the SAME project the app uses
 * (dev: awygszzpyotaddnspikt). For prod, run with prod creds in .env.local.
 *
 * Run:  node scripts/seed-retainer-template.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);

const supabase = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
console.log("=== Seed/refresh Sign Retainer Email Template ===");
console.log("Project:", env.NEXT_PUBLIC_SUPABASE_URL, "\n");

const TEMPLATE_NAME = "Sign Retainer";
const TEMPLATE_SUBJECT = "Please review and sign your retainer{{ side_suffix }}";
const TEMPLATE_BODY = `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827; line-height: 1.6;">
  <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700;">Hi {{ user.first_name }},</h2>
  <p style="margin: 0 0 24px 0; font-size: 15px;">
    Your retainer agreement for the {{ lead_type }} of {{ lead_address }} is ready for your review and signature. You can review and sign it securely below &mdash; no account or password required.
  </p>
  <p style="margin: 24px 0;">
    <a href="{{ confirmation_url }}" style="background-color: #DC2626; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; font-size: 15px;">Review &amp; sign my retainer</a>
  </p>
  <p style="margin: 0 0 24px 0; font-size: 14px; color: #374151;">
    After signing, you'll have the option to activate your account to upload your documents and track your transaction &mdash; or do that later.
  </p>
  <p style="margin: 32px 0 0 0; font-size: 12px; color: #6b7280;">
    If you didn't expect this email, you can safely ignore it. If the button doesn't work, <a href="{{ confirmation_url }}" style="color: #DC2626;">use this link</a> instead.
  </p>
</div>
<br><img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="width:70px;height:auto;" />`;

// Find an existing retainer "please sign" template (name ~ retainer, not "signed").
const { data: existing, error: queryErr } = await supabase
  .from("email_templates")
  .select("id, name, is_active")
  .ilike("name", "%retainer%");

if (queryErr) {
  console.error("❌ Failed to query existing templates:", queryErr.message);
  process.exit(1);
}

const match = (existing ?? []).find(
  (t) => !(t.name ?? "").toLowerCase().includes("signed"),
);

if (match) {
  const { data: updated, error: updErr } = await supabase
    .from("email_templates")
    .update({
      name: TEMPLATE_NAME,
      subject: TEMPLATE_SUBJECT,
      body: TEMPLATE_BODY,
      is_active: true,
    })
    .eq("id", match.id)
    .select()
    .single();
  if (updErr) {
    console.error("❌ Failed to update template:", updErr.message);
    process.exit(1);
  }
  console.log(`✅ Updated existing template (id=${updated.id}) → "${updated.name}"`);
  console.log(`   subject:   ${updated.subject}`);
  console.log(`   is_active: ${updated.is_active}`);
  console.log(`   body:      ${TEMPLATE_BODY.length} chars`);
  process.exit(0);
}

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
  console.error("❌ Failed to insert Sign Retainer template:", insertErr.message);
  process.exit(1);
}

console.log(`✅ Created template (id=${inserted.id}) → "${inserted.name}"`);
console.log(`   subject:   ${inserted.subject}`);
console.log(`   is_active: ${inserted.is_active}`);
console.log(`   body:      ${TEMPLATE_BODY.length} chars`);
