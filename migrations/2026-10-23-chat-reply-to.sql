-- Client chat: reply to a specific message (WhatsApp-style quote).
--
-- deal_messages.reply_to_id points at the message being answered, in the SAME
-- thread. The quote is drawn at read time from the original row, so an edit or
-- delete of the original shows up in every reply that quotes it. ON DELETE SET
-- NULL only matters for a hard delete (an erase); a normal delete is soft.
--
-- A client-visible message may only quote a client-visible message (never a
-- private staff note): enforced in both apps' send routes.
--
-- Safe before or after the deploy: until it runs, the apps read without the
-- column and Reply simply isn't stored.

ALTER TABLE deal_messages
  ADD COLUMN IF NOT EXISTS reply_to_id uuid REFERENCES deal_messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS deal_messages_reply_to_idx
  ON deal_messages (reply_to_id)
  WHERE reply_to_id IS NOT NULL;
