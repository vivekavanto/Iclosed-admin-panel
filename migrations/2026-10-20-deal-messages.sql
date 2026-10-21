-- Client <-> staff messaging ("live chat") on a file.
--
-- A CONVERSATION belongs to a FILE: it is keyed by the family's ROOT lead
-- (leads.parent_lead_id ?? leads.id), so co-purchasers / co-sellers and every
-- staff member share one thread.
--
--   deal_conversations  one row per file: open/resolved, assignee, rating
--   deal_messages       one row per item in the thread
--
-- deal_messages.kind
--   'message'  a normal message (staff -> client emailed; client -> staff)
--   'note'     PRIVATE staff note - never shown to or emailed to the client
--   'event'    "Assigned to ...", "Resolved by ..." pill (sender_type 'system')
-- visible_to_client  false for notes and internal events; the portal only ever
--                    reads rows where this is true.
-- source             'portal' (typed in either app) | 'email' (client replied to
--                    the notification email; ingested by the inbound webhook)
-- email_message_id   Message-ID of an ingested email, for de-duplication
-- read_by_admin_at / read_by_client_at
--                    stamped when the OTHER side opens the thread (drives the
--                    unread counts and the "Delivered / Seen" label)
--
-- New tables: CREATE TABLE does not inherit grants here, so the service_role
-- GRANTs below are required (without them every route 500s with 42501).

CREATE TABLE IF NOT EXISTS deal_conversations (
  root_lead_id    uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  assignee_email  text,
  assignee_name   text,
  rating          integer CHECK (rating BETWEEN 1 AND 5),
  rating_comment  text,
  resolved_at     timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deal_messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind              text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'note', 'event')),
  sender_type       text NOT NULL CHECK (sender_type IN ('admin', 'client', 'system')),
  sender_name       text,
  sender_client_id  uuid,
  sender_email      text,
  body              text NOT NULL,
  source            text NOT NULL DEFAULT 'portal' CHECK (source IN ('portal', 'email')),
  email_message_id  text,
  visible_to_client boolean NOT NULL DEFAULT true,
  read_by_admin_at  timestamptz,
  read_by_client_at timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_messages_root_created_idx
  ON deal_messages (root_lead_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS deal_messages_email_message_id_uidx
  ON deal_messages (email_message_id) WHERE email_message_id IS NOT NULL;

ALTER TABLE deal_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_messages ENABLE ROW LEVEL SECURITY;
GRANT ALL ON deal_conversations TO service_role;
GRANT ALL ON deal_messages TO service_role;

-- Wording is DB-owned (editable without a deploy); the code carries a fallback.
-- Placeholders: {{ client_name }}, {{ sender_name }}, {{ message_body }} (HTML,
-- raw), {{ portal_url }}, {{ file_number }}.
INSERT INTO email_templates (name, subject, body, is_active)
SELECT
  'Client Message',
  'New message from your iClosed team (File {{ file_number }})',
  '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#0f172a;">
  <p>Hi {{ client_name }},</p>
  <p>{{ sender_name }} sent you a message about your file:</p>
  <blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #e11d48;background:#f8fafc;">{{ message_body }}</blockquote>
  <p>You can simply <strong>reply to this email</strong>, or log in to your portal to respond.</p>
  <p style="margin-top:24px;">
    <a href="{{ portal_url }}" style="background:#e11d48;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600;">
      Open my messages
    </a>
  </p>
  <p style="color:#64748b;font-size:13px;margin-top:24px;">File {{ file_number }}</p>
</div>',
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM email_templates WHERE name ILIKE '%Client Message%'
);
