-- "All Tasks Completed" alert — new subject and body
-- ---------------------------------------------------------------------------
-- Wording only. Run it in the Supabase SQL editor; no deploy is involved, and
-- the change is live on the next alert in EVERY environment (the row is in the
-- shared database).
--
-- RECIPIENT — nothing to do here. The alert already goes to
-- aliya@navawilson.law: that is DEFAULT_ALERT_TO in
-- src/lib/notifyAllTasksComplete.ts. The ONLY thing that can override it is the
-- ALL_TASKS_ALERT_TO environment variable, so if the mail is landing elsewhere,
-- check that var in Vercel — unset it (or set it to aliya@navawilson.law) and
-- the default applies. "admins" there means every active admin_users row.
--
-- PLACEHOLDERS — the code resolving these ships per-deploy while this row is
-- read by every environment at once, so a placeholder production hasn't shipped
-- yet emails as literal "{{ … }}" text (this bit us on 2026-08-10). Only these
-- are resolved by the code currently on production:
--   {{ client_name }}      primary client's full name
--   {{ co_party_names }}   co-purchasers / co-sellers, comma separated ("" if none)
--   {{ party_summary }}    ALL parties' full names — "Ravi Anand Maharajh and Preetha Jayanthan"
--   {{ transaction }}      "Sale of 2615 Ellesmere Road, Toronto, Ontario, M5E 0G1"
--   {{ property_address }} the address only, no "Sale of" prefix
--   {{ closing_date }}     "August 31, 2026" or "TBD"
--   {{ file_number }}      "26S-0356"
--   {{ lead_type }}        "Purchase" / "Sale" / "Purchase & Sale"
--   {{ task_count }}       client-visible tasks completed
--   {{ deal_url }}         absolute link to the file in the admin portal
--   {{ document_count }}   documents found on the file
--   {{ attached_count }}   documents attached to this email
--
-- {{ property_street }} — the street line on its own, "2615 Ellesmere Road" —
-- exists ONLY on the dev branch today. Using it now would print the raw
-- placeholder in production, so step 1 below uses {{ property_address }}. Run
-- step 2 instead once dev is merged into main and deployed.

-- ── Step 1: run this now ───────────────────────────────────────────────────
UPDATE email_templates
   SET subject = 'Client documents — {{ property_address }} (#{{ file_number }}, {{ closing_date }})',
       body = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi team,</p>
  <p>
    All tasks are complete on <strong>{{ transaction }}</strong>
    (closing date: <strong>{{ closing_date }}</strong>).
  </p>
  <p style="margin:0 0 4px;"><strong>Clients:</strong> {{ party_summary }}</p>
  <p style="margin-top:24px;">
    <a href="{{ deal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Review file {{ file_number }}
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">
    File {{ file_number }} &middot; {{ lead_type }} &middot; {{ task_count }} tasks completed
  </p>
</div>',
       is_active = TRUE
 WHERE name ILIKE '%All Tasks Completed%';

-- ── Step 2: ONLY after the dev branch is deployed to production ────────────
-- Swaps the full address in the subject for the street line alone, giving
-- exactly "Client documents — 2615 Ellesmere Road (#26S-0356, August 31, 2026)".
--
-- UPDATE email_templates
--    SET subject = 'Client documents — {{ property_street }} (#{{ file_number }}, {{ closing_date }})'
--  WHERE name ILIKE '%All Tasks Completed%';

-- Verification
SELECT id, name, is_active, deleted, subject
  FROM email_templates
 WHERE name ILIKE '%All Tasks Completed%';
