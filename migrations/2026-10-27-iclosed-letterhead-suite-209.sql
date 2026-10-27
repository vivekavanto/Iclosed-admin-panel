-- iClosed's office is Suite 209; Nava Wilson stays at Suite 210.
-- Updates the iClosed letterhead printed on closing cost statements. Only rows
-- still on the old shared address are changed, so an edit made in Settings is kept.

UPDATE closing_cost_config
SET firm_address = 'Suite 209, 10 Milner Business Court, Toronto, Ontario, M1B 3C6'
WHERE firm_key = 'iclosed'
  AND firm_address = 'Suite 210, 10 Milner Business Court, Toronto, Ontario, M1B 3C6';
