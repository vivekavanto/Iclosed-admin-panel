-- SEC-008 — cap how many times an invitation token can be consumed.
--
-- Invitation tokens are intentionally multi-use: email scanners (Outlook
-- SafeLinks, Gmail, corporate gateways) pre-fetch the link before the human
-- clicks, so strict single-use would bounce real customers. But an UNBOUNDED
-- 7-day reuse window means a leaked token (forwarded email, log dump) can be
-- replayed indefinitely. This adds a consumption counter so the link can be
-- refused past a generous cap (see MAX_CONSUMPTIONS in src/lib/invitationToken.ts)
-- while still tolerating a handful of scanner pre-fetches.

ALTER TABLE invitation_tokens
  ADD COLUMN IF NOT EXISTS consumption_count integer NOT NULL DEFAULT 0;
