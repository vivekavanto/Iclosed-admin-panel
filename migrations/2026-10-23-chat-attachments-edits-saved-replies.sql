-- Client chat: attachments, edit / delete, and DB-editable saved replies.
--
-- deal_messages
--   attachments    jsonb array of { url, name, size, type } — files uploaded
--                  straight to Vercel Blob under chat/<root_lead_id>/. Empty for
--                  a text-only message. A message may now be attachment-only, in
--                  which case body is ''.
--   edited_at      stamped by an edit; the thread shows "edited".
--   original_body  the text as first sent, kept on the FIRST edit so the record
--                  of what was said (and emailed) survives later edits.
--   deleted_at / deleted_by
--                  soft delete. The row and its body stay for the record; both
--                  apps return a deleted message with an empty body and no
--                  attachments, and show "This message was deleted".
--
-- chat_saved_replies
--   The "/" shortcuts in the staff composer, previously a constant in
--   MessagesInbox.tsx. Seeded below with that same list, so nothing changes for
--   staff until someone edits them. Without this table the inbox falls back to
--   the built-in list (read-only).
--
-- Safe before or after the code deploy: the code detects the missing columns /
-- table and keeps the old behaviour (only the new features are unavailable).
--
-- New table: CREATE TABLE does not inherit grants here, so the service_role
-- GRANT is required (without it every saved-replies call fails with 42501).

ALTER TABLE deal_messages
  ADD COLUMN IF NOT EXISTS attachments   jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS edited_at     timestamptz,
  ADD COLUMN IF NOT EXISTS original_body text,
  ADD COLUMN IF NOT EXISTS deleted_at    timestamptz,
  ADD COLUMN IF NOT EXISTS deleted_by    text;

CREATE TABLE IF NOT EXISTS chat_saved_replies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut    text NOT NULL CHECK (shortcut ~ '^/[a-z0-9_-]{1,30}$'),
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 80),
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  text,
  updated_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_saved_replies_shortcut_uidx
  ON chat_saved_replies (lower(shortcut));

ALTER TABLE chat_saved_replies ENABLE ROW LEVEL SECURITY;
GRANT ALL ON chat_saved_replies TO service_role;

-- Seed with the list the composer shipped with. Only into an EMPTY table, so a
-- re-run never resurrects a reply staff deleted.
INSERT INTO chat_saved_replies (shortcut, title, body, sort_order)
SELECT v.shortcut, v.title, v.body, v.sort_order
FROM (VALUES
  ('/hi',      'Greeting',           'Hi {name}, thanks for reaching out! Give me a moment to look into this.', 10),
  ('/docs',    'Documents reminder', 'Could you please upload the outstanding documents in your portal under Your Documents? Let me know if anything is unclear.', 20),
  ('/tasks',   'Pending tasks',      'A quick reminder to complete your pending tasks in the portal so we can keep your file moving.', 30),
  ('/closing', 'Closing date',       'Your closing date is on track. I’ll let you know as soon as anything changes.', 40),
  ('/handoff', 'Hand off',           'I’m looping in a colleague who will reply right here in this chat.', 50),
  ('/bye',     'Close out',          'Glad I could help! I’ll mark this as resolved. Just reply here if anything else comes up.', 60)
) AS v(shortcut, title, body, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM chat_saved_replies);
