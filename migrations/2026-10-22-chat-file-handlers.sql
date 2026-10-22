-- Live chat: who has handled a file's conversation, and when
-- (the "delivery history" of a file chat).
--
-- The conversation belongs to the FILE (deal_conversations, keyed by the
-- family's root lead); staff only ever HANDLE it for a while. Each time the
-- handler changes — picked in the inbox, set by a first reply, auto-routed, or
-- moved in bulk when someone leaves — the open row is closed (ended_at) and a
-- new one opened. The inbox side panel shows the list: "Saru (Oct 20 – 22) ->
-- Priya (now)".
--
-- Messages are untouched by this; it is history only. The admin app tolerates
-- the table missing (the list is then just empty), so deploy order does not
-- matter.
--
-- New tables: CREATE TABLE does not inherit grants here, so the service_role
-- GRANT is required (without it every write fails silently behind the
-- best-effort helper, and reads return nothing).

CREATE TABLE IF NOT EXISTS deal_conversation_handlers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  root_lead_id uuid NOT NULL REFERENCES deal_conversations(root_lead_id) ON DELETE CASCADE,
  staff_email  text NOT NULL,
  staff_name   text,
  started_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz
);

CREATE INDEX IF NOT EXISTS deal_conversation_handlers_root_idx
  ON deal_conversation_handlers (root_lead_id, started_at);

ALTER TABLE deal_conversation_handlers ENABLE ROW LEVEL SECURITY;
GRANT ALL ON deal_conversation_handlers TO service_role;

-- Seed the current handler of every conversation that already has one, so the
-- history isn't empty on day one. Their real start is unknown; the
-- conversation's creation time is the honest lower bound.
INSERT INTO deal_conversation_handlers (root_lead_id, staff_email, staff_name, started_at)
SELECT c.root_lead_id, c.assignee_email, c.assignee_name, c.created_at
FROM deal_conversations c
WHERE c.assignee_email IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM deal_conversation_handlers h
    WHERE h.root_lead_id = c.root_lead_id AND h.ended_at IS NULL
  );
