-- Live chat: staff Online / Away and client presence
-- (docs/chat-realtime-implementation-plan.md, phase 2).
--
-- staff_presence      one row per staff email. Each admin tab sends a heartbeat
--                     every 30 s; a row older than 120 s, or status 'offline'
--                     (set when the last tab closes), reads as offline.
--   manual_status     what the staff member picked in the sidebar menu; kept
--                     across reloads until they pick the other one.
--   status            what the last heartbeat computed: manual Away, auto-Away
--                     after 15 min without input, or online.
--
-- deal_conversations.client_online / client_last_seen_at
--                     a client on the file has the portal open (stamped by the
--                     chat widget's poll while the tab is visible, cleared by a
--                     beacon when it is hidden). Drives the inbox's green dot
--                     and "Last seen".
--
-- Both apps read these with the service role and tolerate them missing, so the
-- order of "migrate" and "deploy" does not break the chat; presence just stays
-- dark until this has run.
--
-- New tables: CREATE TABLE does not inherit grants here, so the service_role
-- GRANT is required (without it every presence call fails with 42501).

CREATE TABLE IF NOT EXISTS staff_presence (
  staff_email   text PRIMARY KEY,
  manual_status text NOT NULL DEFAULT 'online' CHECK (manual_status IN ('online', 'away')),
  status        text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away', 'offline')),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE staff_presence ENABLE ROW LEVEL SECURITY;
GRANT ALL ON staff_presence TO service_role;

ALTER TABLE deal_conversations
  ADD COLUMN IF NOT EXISTS client_online       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS client_last_seen_at timestamptz;
