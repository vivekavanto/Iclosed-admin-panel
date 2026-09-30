-- Rebuild every partner referral code in the 2026 naming scheme.
-- ---------------------------------------------------------------------------
-- Codes were a first-name prefix plus a globally sequential number
-- (SARUJAN0001, 2026-07-10-partner-referral-codes.sql). They become
-- FIRST NAME + the initial of the SECOND name + the year:
--
--     Sarujan Kana       → SARUJANK2026
--     Aliya Ali Shaikha  → ALIYAA2026      (the SECOND token, "Ali")
--     Raninder Dhillon   → RANINDERD2026
--
-- Collisions extend into the second name, FIRST COME FIRST SERVED:
--
--     Raninder Khal  (older) → RANINDERK2026
--     Raninder Khali (newer) → RANINDERKH2026
--
-- ⚠ THIS CHANGES CODES CLIENTS MAY ALREADY HOLD. A partner who has given out
-- SARUJAN0001 will find it no longer validates at intake — nothing maps an old
-- code to its replacement (leads link by `partner_id`, not by code, so existing
-- files are unaffected). The old → new mapping is returned as this script's
-- result set: SAVE IT before closing the editor, because it is not stored
-- anywhere. Re-running the script does NOT reproduce it — see below.
--
-- ── NOT IDEMPOTENT IN THE USUAL SENSE ──────────────────────────────────────
-- Re-running is harmless but pointless: rows already in the new scheme keep the
-- code they hold, because each row's own code is freed before its replacement is
-- chosen, so the first free candidate is the one it already has. What it will
-- NOT do is re-derive a code from a name that changed in the meantime — a
-- referral code is written once and is stable for the life of the partner.
--
-- ── ORDER MATTERS ──────────────────────────────────────────────────────────
-- Live partners are processed first (oldest first), then soft-deleted ones, so
-- an active partner gets the short code and a retired one takes the longer
-- variant. Deleted rows are renamed too: the unique index is partial on
-- `is_deleted = false`, so leaving them on old-scheme codes would be harmless,
-- but a restored partner would then be the only one with a stale code.
--
-- Mirrors src/lib/referralCode.ts (and the portal's copy). If the rule changes
-- there, it changes here; this is the only place it exists in SQL.
--
-- ── PREVIEW FIRST ──────────────────────────────────────────────────────────
-- To see the mapping WITHOUT changing anything, run the script with a `BEGIN;`
-- pasted above it and `ROLLBACK;` below it. The result set is identical; the
-- UPDATEs are thrown away. Run it for real once the names look right.

DROP TABLE IF EXISTS _referral_code_renames;
CREATE TEMP TABLE _referral_code_renames (
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
  -- Every code currently in use, so a candidate never lands on a code that a
  -- not-yet-processed row still holds. Each row's own code is removed from this
  -- set just before its replacement is picked, which is what lets a row keep the
  -- code it already has on a re-run.
  DROP TABLE IF EXISTS _used;
  CREATE TEMP TABLE _used AS
    SELECT upper(btrim(referral_code)) AS code
    FROM partners
    WHERE referral_code IS NOT NULL AND btrim(referral_code) <> '';

  FOR r IN
    SELECT id, agent_name, agent_email, referral_code, is_deleted
    FROM partners
    ORDER BY is_deleted ASC, created_at ASC NULLS LAST, id ASC
  LOOP
    v_tokens := regexp_split_to_array(btrim(coalesce(r.agent_name, '')), '\s+');

    -- First name: letters only, uppercased. Falls back to the email local-part,
    -- then to PTNR — agent_name is nullable and intake can create a partner from
    -- an email alone.
    v_first := upper(regexp_replace(coalesce(v_tokens[1], ''), '[^A-Za-z]', '', 'g'));
    IF v_first = '' THEN
      v_first := upper(regexp_replace(split_part(coalesce(r.agent_email, ''), '@', 1),
                                      '[^A-Za-z]', '', 'g'));
    END IF;
    IF v_first = '' THEN
      v_first := 'PTNR';
    END IF;
    v_first := left(v_first, 20);

    -- Second name: the SECOND token, not the last. "Aliya Ali Shaikha" → ALI.
    v_second := left(
      upper(regexp_replace(coalesce(v_tokens[2], ''), '[^A-Za-z]', '', 'g')), 12);

    -- This row's own code stops blocking its replacement.
    DELETE FROM _used WHERE code = upper(btrim(coalesce(r.referral_code, '')));

    v_chosen := NULL;

    IF v_second = '' THEN
      v_candidate := v_first || '2026';
      IF NOT EXISTS (SELECT 1 FROM _used WHERE code = v_candidate) THEN
        v_chosen := v_candidate;
      END IF;
    ELSE
      FOR k IN 1..length(v_second) LOOP
        v_candidate := v_first || left(v_second, k) || '2026';
        IF NOT EXISTS (SELECT 1 FROM _used WHERE code = v_candidate) THEN
          v_chosen := v_candidate;
          EXIT;
        END IF;
      END LOOP;
    END IF;

    -- Identical first AND second name: number it, before the year, so every code
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
      INSERT INTO _referral_code_renames(id, agent_name, old_code, new_code)
      VALUES (r.id, r.agent_name, r.referral_code, v_chosen);
    END IF;
  END LOOP;

  DROP TABLE _used;
END $$;

-- The mapping. Save this — it is the only record of what each partner's code
-- used to be, and support will need it for anyone quoting an old code.
SELECT agent_name, old_code, new_code
FROM _referral_code_renames
ORDER BY agent_name NULLS LAST;

-- Sanity: must return zero rows. Codes are unique (case-insensitively) among
-- live partners, and every live code ends in the cohort year.
SELECT 'duplicate' AS problem, lower(referral_code) AS value, count(*) AS row_count
FROM partners
WHERE is_deleted = false AND referral_code IS NOT NULL
GROUP BY lower(referral_code)
HAVING count(*) > 1
UNION ALL
SELECT 'not-2026', referral_code, 1
FROM partners
WHERE is_deleted = false
  AND (referral_code IS NULL OR referral_code NOT LIKE '%2026');
