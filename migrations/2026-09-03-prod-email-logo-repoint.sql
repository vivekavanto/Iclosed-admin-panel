-- Bring PRODUCTION's email lockup up to the dev standard.
--
-- ── WHAT IS ACTUALLY WRONG (measured 2026-09-03, not assumed) ───────────
-- No send code injects the logo. It is a literal <img> inside each
-- email_templates.body row, so it is DATA: fixing dev's rows never touched
-- prod's, and no deploy will. Prod and dev are separate Supabase projects with
-- separate, diverged rows.
--
-- Prod, all 21 logo-bearing rows, byte-identical:
--   <img src="https://iclosed-admin-panel.vercel.app/logo.png"
--        alt="iClosed by Nava Wilson"
--        style="display:block;margin:2px 0 0 0;width:70px;height:auto;" />
--
-- Dev, the intended shape:
--   <img src="https://devadmin.iclosed.ca/email-logo.png" alt="iClosed"
--        width="85" style="width:85px;max-width:100%;height:auto;display:block;border:0;" />
--
-- So prod is still on `logo.png` — the bare wordmark at 70px — and never
-- received the rename to `email-logo.png` (the lockup). That host DOES serve
-- logo.png, which is why the client sees an OLD logo rather than a broken
-- image. Confirmed by a query that found zero prod rows mentioning
-- "email-logo".
--
-- Hosts, all checked today:
--   https://admin.iclosed.ca/email-logo.png                 200, current artwork
--   https://devadmin.iclosed.ca/email-logo.png              200, identical ETag
--   https://iclosed-admin-panel.vercel.app/email-logo.png   404  ← so the
--     filename cannot simply be swapped while keeping prod's current host;
--     the host has to move too, to one that actually has the file.
--
-- Two separate defects, both fixed below:
--   1. 21 rows pointing at the old wordmark        → section 1 swaps the tag
--   2. 2 client-facing rows with NO <img> at all   → section 2 inserts it
--      ("Deposit Funds Task Added", "Deposit Proof Received" — both carry the
--       lockup on dev)
--
-- ⚠ CHECK target_host BELOW. It must be the domain the PRODUCTION admin app is
-- served from, because that app's public/ folder is what serves the image.
-- admin.iclosed.ca is used here: it answers /admin/login and serves the current
-- artwork. Do NOT point prod rows at devadmin — production email would then
-- depend on the dev deployment staying up.
--
-- Cache note: the URL changes host AND filename, so Gmail/Outlook (which cache
-- proxied images by exact URL) fetch it fresh. No cache-busting needed.
--
-- Idempotent: every statement is guarded, so re-running changes nothing.


-- ---------------------------------------------------------------------------
-- 0. BEFORE — one line per distinct image tag
-- ---------------------------------------------------------------------------
SELECT substring(body from '<img[^>]*>') AS img_tag,
       count(*) AS templates
  FROM email_templates
 WHERE COALESCE(is_deleted, false) = false
   AND body ~* '<img'
 GROUP BY 1
 ORDER BY 2 DESC;


-- ---------------------------------------------------------------------------
-- 1. Swap the old wordmark for the lockup
-- ---------------------------------------------------------------------------
-- Three passes, narrowest first. Note none of them is a blanket <img[^>]*>
-- wildcard: that would also eat any legitimate non-logo image a template
-- carries. Each pass targets the logo and nothing else.
--
-- is_deleted rows are INCLUDED on purpose. They send nothing, but leaving them
-- behind means a later "is the old URL gone?" check still returns hits and
-- looks like the migration failed.

DO $$
DECLARE
  -- TARGET ──────────────────────────────────────────────────────────────
  target_host text := 'https://admin.iclosed.ca';
  -- Change target_file ONLY to bust a mail-client image cache, and only to a
  -- filename already deployed to target_host — check it in an incognito window
  -- first, or every email renders a broken image the moment this runs.
  target_file text := 'email-logo.png';
  -- ──────────────────────────────────────────────────────────────────────
  old_tag   text :=
    '<img src="https://iclosed-admin-panel.vercel.app/logo.png" alt="iClosed by Nava Wilson" style="display:block;margin:2px 0 0 0;width:70px;height:auto;" />';
  canonical text;
  n_exact   int;
  n_variant int;
  n_rehost  int;
BEGIN
  -- alt/width/style copied verbatim from the dev rows. Width 85 is not
  -- cosmetic: it is the value emailBrand.ts expects for this lockup once the
  -- firm-branding code reaches main (each firm's artwork is cropped
  -- differently and carries its own width).
  canonical :=
    '<img src="' || target_host || '/' || target_file || '" alt="iClosed" width="85" ' ||
    'style="width:85px;max-width:100%;height:auto;display:block;border:0;" />';

  -- (a) the exact tag all 21 prod rows share — a plain replace, no regex risk
  UPDATE email_templates
     SET body = replace(body, old_tag, canonical)
   WHERE body LIKE '%' || old_tag || '%';
  GET DIAGNOSTICS n_exact = ROW_COUNT;

  -- (b) any hand-edited variant still pointing at the old asset
  UPDATE email_templates
     SET body = regexp_replace(
           body,
           '<img[^>]*iclosed-admin-panel\.vercel\.app/logo\.png[^>]*>',
           canonical,
           'gi'
         )
   WHERE body ~* '<img[^>]*iclosed-admin-panel\.vercel\.app/logo\.png[^>]*>';
  GET DIAGNOSTICS n_variant = ROW_COUNT;

  -- (c) rows already on email-logo but at another host or size (this is what
  --     dev would need; on prod it should report 0)
  UPDATE email_templates
     SET body = regexp_replace(body, '<img[^>]*email-logo[^>]*>', canonical, 'gi')
   WHERE body ~* '<img[^>]*email-logo[^>]*>'
     AND body NOT LIKE '%' || canonical || '%';
  GET DIAGNOSTICS n_rehost = ROW_COUNT;

  RAISE NOTICE 'lockup swapped — exact: %, variants: %, re-hosted: % | now: %',
    n_exact, n_variant, n_rehost, canonical;
END $$;


-- ---------------------------------------------------------------------------
-- 2. Add the lockup to the client-facing rows that have none
-- ---------------------------------------------------------------------------
-- Prod's "active rows with no <img>" list was:
--
--   All Tasks Completed        staff notification  → correctly has no logo
--   Client Documents to Clerk  staff notification  → correctly has no logo
--   Log into iClosed           has no logo on dev either → leave as is
--   Deposit Funds Task Added   CLIENT-FACING, has the lockup on dev  ← fix
--   Deposit Proof Received     CLIENT-FACING, has the lockup on dev  ← fix
--
-- The name list is explicit rather than "every row without an <img>": a blanket
-- rule would stamp a client lockup onto staff mail.
--
-- Placement mirrors dev — immediately after the "Warm regards," line, inside
-- the wrapper div. Three branches tried in order cover whatever shape prod's
-- older bodies have; each is guarded by "still has no <img>", so a row fixed by
-- an earlier branch is skipped by the later ones.

DO $$
DECLARE
  target_host text := 'https://admin.iclosed.ca';
  target_file text := 'email-logo.png';
  needs_logo  text[] := ARRAY['Deposit Funds Task Added', 'Deposit Proof Received'];
  canonical   text;
  n_signoff   int;
  n_wrapper   int;
  n_appended  int;
BEGIN
  canonical :=
    '<img src="' || target_host || '/' || target_file || '" alt="iClosed" width="85" ' ||
    'style="width:85px;max-width:100%;height:auto;display:block;border:0;" />';

  -- (a) after the sign-off paragraph — where dev puts it
  UPDATE email_templates
     SET body = regexp_replace(
           body,
           '(<p[^>]*>\s*Warm regards,\s*</p>)',
           '\1' || E'\n  ' || canonical,
           'i'
         )
   WHERE name = ANY (needs_logo)
     AND body !~* '<img'
     AND body ~* '<p[^>]*>\s*Warm regards,\s*</p>';
  GET DIAGNOSTICS n_signoff = ROW_COUNT;

  -- (b) no sign-off line: just inside the closing wrapper
  UPDATE email_templates
     SET body = regexp_replace(body, '(</div>\s*)$', canonical || E'\n' || '\1', 'i')
   WHERE name = ANY (needs_logo)
     AND body !~* '<img'
     AND body ~* '</div>\s*$';
  GET DIAGNOSTICS n_wrapper = ROW_COUNT;

  -- (c) neither: append
  UPDATE email_templates
     SET body = body || E'\n' || canonical
   WHERE name = ANY (needs_logo)
     AND body !~* '<img';
  GET DIAGNOSTICS n_appended = ROW_COUNT;

  RAISE NOTICE 'lockup added — after sign-off: %, inside wrapper: %, appended: %',
    n_signoff, n_wrapper, n_appended;
END $$;


-- ---------------------------------------------------------------------------
-- 3. AFTER — expect ONE tag, on the prod host, across every template
-- ---------------------------------------------------------------------------
SELECT substring(body from '<img[^>]*>') AS img_tag,
       count(*) AS templates
  FROM email_templates
 WHERE COALESCE(is_deleted, false) = false
   AND body ~* '<img'
 GROUP BY 1
 ORDER BY 2 DESC;

-- Nothing left on the old host (expect 0):
SELECT count(*) AS still_on_old_host
  FROM email_templates
 WHERE body ILIKE '%iclosed-admin-panel.vercel.app/logo.png%';

-- Active rows still with no image (expect only the staff rows and
-- "Log into iClosed"):
SELECT name
  FROM email_templates
 WHERE COALESCE(is_deleted, false) = false
   AND is_active
   AND body !~* '<img'
 ORDER BY name;
