-- Seed the foundational email templates (Welcome, Invite User, Reset
-- Password) into email_templates so admins can manage them via the
-- /admin/templates/emails UI instead of relying on hardcoded fallbacks in
-- sendWelcomeEmail.ts and sendAuthEmail.ts.
--
-- Idempotent: each INSERT is guarded by NOT EXISTS, so this is safe to
-- re-run. Run once in Supabase SQL Editor BEFORE deploying the code
-- changes that strip the hardcoded fallbacks.

-- ─────────────────────────────────────────────────────────────────────
-- 1. Welcome / Initial Intake email
-- ─────────────────────────────────────────────────────────────────────
-- Content matches the original hardcoded DEFAULT_WELCOME_BODY that fired
-- before the fallback was removed. This restores the exact email customers
-- were receiving previously after each intake submission.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Welcome Email',
  'Welcome to iClosed',
  E'<p>Hi {{ user.first_name }},</p>\n\n<p>Congratulations on your {{ lead_type }} of {{ lead_address }}.</p>\n\n<p>One of our team members will be reaching out to you shortly to walk you through the next steps.</p>\n\n<p>In the meantime, feel free to explore the resources below to learn more about our services and how we structure our pricing:</p>\n\n<ul>\n  <li><a href="https://navawilson.law/title-insurance">Why Do You Need Title Insurance?</a></li>\n  <li><a href="https://navawilson.law/transaction-costs">Understanding Real Estate Transaction Costs</a></li>\n  <li><a href="https://navawilson.law/disbursements">What Are Disbursements?</a></li>\n</ul>\n\n<p>We look forward to connecting with you soon!</p>\n\n<p>Warm regards,</p>\n<p>iClosed by Nava Wilson</p>',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE 'welcome%'
);

-- ─────────────────────────────────────────────────────────────────────
-- 2. Invite User / Activate Account email
-- ─────────────────────────────────────────────────────────────────────
-- Must include {{ confirmation_url }} — that's the magic link the customer
-- clicks to set their password. Removing or breaking it leaves new
-- customers unable to log in.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Invite User',
  'Activate your iClosed account',
  E'<div style="font-family: -apple-system, BlinkMacSystemFont, ''Segoe UI'', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #111827; line-height: 1.6;">\n  <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700;">Hi {{ user.first_name }},</h2>\n  <p style="margin: 0 0 24px 0; font-size: 15px;">\n    You''ve been invited to access your secure iClosed customer portal. Click the button below to accept your invitation and set your password. <strong>Link expires in 24 hours.</strong>\n  </p>\n  <p style="margin: 24px 0;">\n    <a href="{{ confirmation_url }}" style="background-color: #DC2626; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; display: inline-block; font-size: 15px;">Activate my account</a>\n  </p>\n  <p style="margin: 32px 0 0 0; font-size: 12px; color: #6b7280;">\n    If you didn''t request this invitation, you can safely ignore this email. No account will be created without your action. If the button doesn''t work, <a href="{{ confirmation_url }}" style="color: #DC2626;">use this link</a> instead.\n  </p>\n</div>',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
  WHERE name ILIKE 'invite%' OR name ILIKE 'activate%'
);

-- ─────────────────────────────────────────────────────────────────────
-- 3. Reset Password email
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Reset Password',
  'Reset Your Password — iClosed',
  E'<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">\n  <p>Hi {{ user.first_name }},</p>\n  <p>We received a request to reset your password for your <strong>iClosed</strong> account.</p>\n  <p>Click the button below to set a new password:</p>\n  <p style="text-align: center; margin: 30px 0;">\n    <a href="{{ confirmation_url }}" style="background-color: #1a1a2e; color: #ffffff; padding: 12px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Reset Password</a>\n  </p>\n  <p style="font-size: 13px; color: #666;">If the button above doesn''t work, <a href="{{ confirmation_url }}" style="color: #1a1a2e;">use this link</a> instead.</p>\n  <p style="font-size: 13px; color: #666;">If you did not request a password reset, you can safely ignore this email.</p>\n</div>',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates
  WHERE name ILIKE 'reset%' OR name ILIKE '%password%'
);

-- Verify
SELECT id, name, subject, is_active, created_at
FROM email_templates
WHERE name IN ('Welcome', 'Invite User', 'Reset Password')
ORDER BY name;
