-- Lock box code: a per-deal field for Purchase files. The admin records the
-- property's lock box code on the deal (Edit deal modal, shown only for
-- Purchase / Purchase & Sale deals), and it feeds the {{ lockbox_code }} email
-- template variable used by milestone/stage emails.
--
-- Kept per-deal like property_address (NOT mirrored across the co-purchaser/
-- co-seller family) since it describes the specific property on that deal.

ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS lockbox_code text;
