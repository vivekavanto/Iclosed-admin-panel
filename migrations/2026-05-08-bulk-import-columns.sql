-- Bulk import: deals table needs to store CSV-only fields (clerk/lawyer
-- names, file name, outstanding counters) and to allow rows that aren't
-- linked to a lead or client (bulk-imported rows have neither).

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS clerk_name text,
  ADD COLUMN IF NOT EXISTS lawyer_name text,
  ADD COLUMN IF NOT EXISTS file_name text,
  ADD COLUMN IF NOT EXISTS outstanding_undertakings integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS outstanding_requisitions integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source text;

ALTER TABLE deals ALTER COLUMN lead_id   DROP NOT NULL;
ALTER TABLE deals ALTER COLUMN client_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deals_file_number_key ON deals (file_number);
