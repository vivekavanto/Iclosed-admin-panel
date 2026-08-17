-- Admin note on a file: a short free-text line the admin types on the All Files
-- list to record where the file is actually at ("waiting on lender", "closing
-- moved to the 30th"). It is internal-only — nothing renders it to the client
-- portal, and no email template reads it.
--
-- Mirrored across the co-purchaser/co-seller family (see MIRROR_DEAL_COLUMNS in
-- src/app/api/admin/deals/[id]/route.ts): one file, one note — the list shows
-- one row per file, so a per-person note would be invisible and confusing.
--
-- Length is capped at the API (500 chars), not by the column type, so an
-- existing longer value could never block an unrelated edit.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS admin_note text;
