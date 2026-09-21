-- Repair partner referral codes that do NOT end in the 2026 cohort year.
--
-- Symptom: a partner added on 2026-09-17 got DINUSHA2027.
--
-- Cause: the code still running in PRODUCTION is the OLD sequential scheme
-- (main, both repos — src/app/api/admin/partners/route.ts and the portal's
-- resolvePartner.ts). It builds a code as prefix + the globally largest
-- TRAILING NUMBER + 1, zero-padded to four digits:
--
--     `${prefix}${String(maxNum + attempt).padStart(4, "0")}`
--
-- That scan reads the whole `referral_code` column. Once
-- 2026-09-17-referral-codes-2026.sql rewrote every code to end in 2026, the
-- largest trailing number in the table WAS 2026 — so the very next partner was
-- issued 2027, and the one after that would take 2028. The number is no longer
-- a sequence; it is the cohort year being incremented.
--
-- The generator that replaces it (src/lib/referralCode.ts, on `dev` in both
-- repos) has no sequence at all — the year is the constant REFERRAL_CODE_YEAR —
-- so this stops for good as soon as `dev` reaches `main`. THIS FILE ONLY FIXES
-- THE CODES ALREADY ISSUED; without that deploy the next partner created in
-- production is issued 2027 again.
--
-- Scope: rows whose code is NULL or does not end in 2026. A partner already on
-- a correct 2026 code keeps it, untouched — a referral code is written once and
-- is stable, and agents hold the ones already in their hands.
--
-- ── PREVIEW FIRST ──────────────────────────────────────────────────────────
-- Paste `BEGIN;` above and `ROLLBACK;` below to see the mapping without
-- changing anything; the result sets are identical.

DROP TABLE IF EXISTS _referral_code_repairs;
CREATE TEMP TABLE _referral_code_repairs (
  id          uuid PRIMARY KEY,
  agent_name  text,
  old_code    text,
  new_code    text
);

DO $$
DECLARE
  r            RECORD;
  v_tokens     text[];
  v_first      text;
  v_second     text;
  v_candidate  text;
  v_chosen     text;
  k            int;
  n            int;
BEGIN
  -- Every code currently in use — including the correct ones this script will
  -- not touch — so a repaired code can never land on a code someone else holds.
  DROP TABLE IF EXISTS _used;
  CREATE TEMP TABLE _used AS
    SELECT upper(btrim(referral_code)) AS code
    FROM partners
    WHERE referral_code IS NOT NULL AND btrim(referral_code) <> '';

  FOR r IN
    SELECT id, agent_name, agent_email, referral_code
    FROM partners
    WHERE referral_code IS NULL
       OR btrim(referral_code) = ''
       OR upper(btrim(referral_code)) NOT LIKE '%2026'
    -- Oldest first, so a collision between two broken rows is resolved the same
    -- way the app resolves it: first come, first served.
    ORDER BY created_at ASC NULLS LAST, id ASC
  LOOP
    v_tokens := regexp_split_to_array(btrim(coalesce(r.agent_name, '')), '\s+');

    -- Same rule as src/lib/referralCode.ts: first name + the initial of the
    -- SECOND name + the year, letters only, uppercased. "Dinusha Hallinne
    -- Guruge" → DINUSHAH2026 (the SECOND token, not the last).
    v_first := upper(regexp_replace(coalesce(v_tokens[1], ''), '[^A-Za-z]', '', 'g'));
    IF v_first = '' THEN
      v_first := upper(regexp_replace(split_part(coalesce(r.agent_email, ''), '@', 1),
                                      '[^A-Za-z]', '', 'g'));
    END IF;
    IF v_first = '' THEN
      v_first := 'PTNR';
    END IF;
    v_first := left(v_first, 20);

    v_second := left(
      upper(regexp_replace(coalesce(v_tokens[2], ''), '[^A-Za-z]', '', 'g')), 12);

    -- This row's own (wrong) code stops blocking its replacement, and makes the
    -- script safe to re-run.
    DELETE FROM _used WHERE code = upper(btrim(coalesce(r.referral_code, '')));

    v_chosen := NULL;

    IF v_second = '' THEN
      v_candidate := v_first || '2026';
      IF NOT EXISTS (SELECT 1 FROM _used WHERE code = v_candidate) THEN
        v_chosen := v_candidate;
      END IF;
    ELSE
      -- A clash takes one more letter of the second name: RANINDERK2026 taken →
      -- RANINDERKH2026.
      FOR k IN 1..length(v_second) LOOP
        v_candidate := v_first || left(v_second, k) || '2026';
        IF NOT EXISTS (SELECT 1 FROM _used WHERE code = v_candidate) THEN
          v_chosen := v_candidate;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    -- Identical first AND second name: number it BEFORE the year, so every code
    -- still ends in the cohort year.
    IF v_chosen IS NULL THEN
      FOR n IN 2..99 LOOP
        v_candidate := v_first || v_second || n::text || '2026';
        IF NOT EXISTS (SELECT 1 FROM _used WHERE code = v_candidate) THEN
          v_chosen := v_candidate;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    IF v_chosen IS NULL THEN
      RAISE EXCEPTION 'No free referral code for partner % (%)', r.id, r.agent_name;
    END IF;

    INSERT INTO _used(code) VALUES (v_chosen);

    IF v_chosen IS DISTINCT FROM r.referral_code THEN
      UPDATE partners SET referral_code = v_chosen WHERE id = r.id;
      INSERT INTO _referral_code_repairs(id, agent_name, old_code, new_code)
      VALUES (r.id, r.agent_name, r.referral_code, v_chosen);
    END IF;
  END LOOP;

  DROP TABLE _used;
END $$;

-- What changed. Save it — a partner who was already given the 2027 code will
-- quote it, and this is the only record of the swap. Any client who typed the
-- old code at intake keeps their partner link (leads.partner_id), but the old
-- code itself stops validating.
SELECT agent_name, old_code, new_code
FROM _referral_code_repairs
ORDER BY agent_name NULLS LAST;

-- Sanity: must return zero rows.
SELECT 'duplicate' AS problem, lower(referral_code) AS value, count(*) AS row_count
FROM partners
WHERE is_deleted = false AND referral_code IS NOT NULL
GROUP BY lower(referral_code)
HAVING count(*) > 1
UNION ALL
SELECT 'not-2026', referral_code, 1
FROM partners
WHERE is_deleted = false
  AND (referral_code IS NULL OR upper(btrim(referral_code)) NOT LIKE '%2026');
