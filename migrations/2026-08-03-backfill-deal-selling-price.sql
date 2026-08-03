-- Backfill deals.selling_price from the lead that owns each deal.
--
-- Why it matters: a Purchase & Sale file has TWO amounts — the purchase price
-- and the sale price. Intake captures both onto the primary lead
-- (leads.price + leads.selling_price), but convertLead only ever copied the
-- purchase amount onto the deal (`price: cleanPrice ?? 0`); it never wrote
-- deals.selling_price. The column has existed all along and has been NULL on
-- effectively every deal ever created, so the sale amount was captured at
-- intake and then lost the moment the lead was converted.
--
-- Source of truth is the ROOT lead. Co-purchasers / co-sellers are separate
-- lead rows (parent_lead_id -> primary), and the co-client create path copies
-- the root's `price` onto the child but NOT `selling_price` (see
-- src/app/api/admin/deals/[id]/co-clients/route.ts) — so a co-lead's own
-- selling_price is almost always NULL. We therefore resolve
-- COALESCE(root.selling_price, lead.selling_price) so every deal in a family
-- lands on the same sale amount as the primary.
--
-- Deliberately NOT filtered by deal type: only combined Purchase & Sale roots
-- carry a selling_price at all, so the type filter would be redundant, and
-- hard-coding it would skip co-lead deals that were narrowed to a single side
-- inside a P&S family.
--
-- Non-destructive: only fills deals whose selling_price is currently NULL or 0.
-- A non-zero value an admin already set by hand is never overwritten. Verified
-- against both databases before writing this — 0 conflicting rows on each
-- (dev: 64 rows to fill, prod: 20).
--
-- Idempotent: safe to re-run.

BEGIN;

UPDATE deals AS d
SET selling_price = src.selling_price
FROM (
  -- NULLIF(...,0) so a root storing a literal 0 is treated as "no amount" and
  -- we fall through to the lead's own value, rather than propagating the 0.
  SELECT l.id AS lead_id,
         COALESCE(NULLIF(root.selling_price, 0), NULLIF(l.selling_price, 0)) AS selling_price
  FROM leads AS l
  LEFT JOIN leads AS root ON root.id = l.parent_lead_id
) AS src
WHERE src.lead_id = d.lead_id
  AND src.selling_price IS NOT NULL
  AND src.selling_price > 0
  AND (d.selling_price IS NULL OR d.selling_price = 0);

COMMIT;

-- Verification: every deal whose family root carries a sale amount, and what
-- the deal now holds. `still_missing` should be 0 rows after this runs.
SELECT d.file_number,
       d.type                                   AS deal_type,
       d.price                                  AS purchase_price,
       d.selling_price                          AS sale_price,
       COALESCE(root.selling_price, l.selling_price) AS expected_sale_price
FROM deals d
JOIN leads l ON l.id = d.lead_id
LEFT JOIN leads root ON root.id = l.parent_lead_id
WHERE COALESCE(root.selling_price, l.selling_price) IS NOT NULL
  AND COALESCE(root.selling_price, l.selling_price) > 0
ORDER BY d.file_number;

-- Should return zero rows:
SELECT count(*) AS still_missing
FROM deals d
JOIN leads l ON l.id = d.lead_id
LEFT JOIN leads root ON root.id = l.parent_lead_id
WHERE COALESCE(root.selling_price, l.selling_price) > 0
  AND (d.selling_price IS NULL OR d.selling_price = 0);
