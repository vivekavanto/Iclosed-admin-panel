-- When deals.admin_note was last added/edited — the "Last updated" column on the
-- All Files list. Stamped by the PATCH route; mirrored across the family with
-- the note itself. Existing notes stay NULL (their edit time was never recorded).

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS admin_note_updated_at timestamptz;
