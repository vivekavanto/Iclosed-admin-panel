-- "Email to Clerk" wording moves into email_templates
-- ---------------------------------------------------------------------------
-- The clerk document email (deal page → "Email to Clerk") used to be generated
-- entirely in code. This seeds the row that owns its wording so staff can retune
-- the subject and body in Admin → Templates without a deploy.
--
-- src/lib/sendClerkDocumentsEmail.ts looks the row up with
--   name ILIKE '%Client Documents to Clerk%' AND deleted = false AND is_active
-- and falls back to the built-in body when it is missing, inactive or empty —
-- so running this migration is OPTIONAL. Deleting or deactivating the row later
-- simply returns the email to the built-in wording; it never blocks the send.
--
-- Placeholders resolved by src/lib/sendClerkDocumentsEmail.ts. Anything else is
-- left in the email verbatim, so only use the names below:
--   {{ client_names }}     every party on the file, full names — "Jane Doe and John Doe"
--   {{ client_name }}      the primary client only
--   {{ co_party_names }}   co-purchasers / co-sellers, comma separated ("" if none)
--   {{ party_summary }}    alias of {{ client_names }}
--   {{ transaction }}      "Sale of 2615 Ellesmere Road, Toronto, Ontario, M5E 0G1"
--   {{ property_street }}  street line only — "2615 Ellesmere Road"
--   {{ property_address }} full address(es), city and postal code included
--   {{ file_number }}      the family's shared file number, e.g. "26S-0356"
--   {{ lead_type }}        "Purchase" / "Sale" / "Purchase & Sale"
--   {{ closing_date }}     "August 31, 2026" or "TBD"
--   {{ attached_count }}   documents attached to this email
--   {{ linked_count }}     documents too large to attach (sent as links)
--   {{ document_count }}   attached + linked
--   {{ deal_url }}         absolute link to the file in the admin portal
--
-- NOTE: the "too large to attach" link list is appended by the code after the
-- body — it is not a placeholder, and it only appears when there is something to
-- list.

INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Client Documents to Clerk',
  'Client documents — {{ property_street }} (#{{ file_number }}, {{ closing_date }})',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi,</p>
  <p>
    Please find attached the client documents for <strong>{{ client_names }}</strong> — {{ transaction }}.
  </p>
  <p style="margin:0 0 4px;"><strong>Clients:</strong> {{ client_names }}</p>
  <p>{{ attached_count }} documents are attached as separate files.</p>
  <p style="margin-top:24px;">
    <a href="{{ deal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open file {{ file_number }}
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">
    File {{ file_number }} &middot; {{ lead_type }} &middot; Closing {{ closing_date }}
  </p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Client Documents to Clerk%'
);

-- Verification
SELECT id, name, is_active, deleted, subject
  FROM email_templates
 WHERE name ILIKE '%Client Documents to Clerk%';
