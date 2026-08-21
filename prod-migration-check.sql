-- Read-only. Run in the PROD Supabase SQL editor.
-- PART 2 — the data-only migrations the schema probe could not see.
-- applied = false  →  run that file.
SELECT * FROM (
VALUES
 ('2026-08-05-activate-iclosed-firm',
  EXISTS (SELECT 1 FROM closing_cost_config
           WHERE firm_key='iclosed' AND is_deleted=false AND is_active=true)),

 ('2026-08-08-closing-cost-draft-footer-note',
  NOT EXISTS (SELECT 1 FROM closing_cost_statement_types
               WHERE type_key='draft' AND is_deleted=false
                 AND COALESCE(footer_note,'')='')),

 ('2026-08-10-client-signup-notifications',
  NOT EXISTS (SELECT 1 FROM email_templates
               WHERE name='All Tasks Completed'
                 AND (body LIKE '%{{ attached_count }}%' OR body LIKE '%{{ document_count }}%'))),

 ('2026-08-12-statement-title-drop-property-qualifier',
  NOT EXISTS (SELECT 1 FROM closing_cost_statement_types
               WHERE is_deleted=false AND title LIKE '%RESIDENTIAL PURCHASE (ONTARIO)%')),

 ('2026-08-18-all-tasks-complete-email-wording',
  EXISTS (SELECT 1 FROM email_templates
           WHERE name ILIKE '%All Tasks Completed%'
             AND subject LIKE 'Client documents %')),

 ('2026-08-18-toronto-mltt-2026-graduated-rates',
  NOT EXISTS (SELECT 1 FROM closing_cost_shared_rates
               WHERE mltt_tiers IS DISTINCT FROM
                     '[[55000,0.005],[250000,0.010],[400000,0.015],[2000000,0.020],[3000000,0.025],[4000000,0.044],[5000000,0.0545],[10000000,0.065],[20000000,0.0755],[null,0.086]]'::jsonb))
) AS t(migration, applied)
ORDER BY applied, migration;
