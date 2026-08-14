import supabaseAdmin from "./supabaseAdmin";
import { normalizeRecipientEmail } from "./emailIdentity";
import { logger } from "./logger";

/**
 * Builds the CC list for a file's outbound email.
 *
 * CC used to be single-valued everywhere — `partners.agent_email` is one scalar
 * column and both call sites hardcoded `cc = [partner.agent_email]`, so a
 * brokerage with an agent plus an assistant, or a file where a second party
 * needed copying, simply could not be expressed. The list is now the union of:
 *
 *   1. `partners.agent_email`        — the partner's primary contact (unchanged)
 *   2. `partner_contacts`            — additional people for that partner
 *   3. `deals.cc_emails`             — one-off addresses for THIS file only
 *
 * De-duped case-insensitively, with the client's own address removed so nobody
 * appears in both To and CC.
 *
 * Two deliberate robustness choices, both because a CC is strictly less
 * important than the client's email actually arriving:
 *
 *   - A malformed address is DROPPED and logged, not passed through. Resend
 *     rejects the entire send if any one CC is invalid, which would mean a bad
 *     assistant address silently blocks the client's email.
 *   - A missing table (migration not yet applied) is treated as "no contacts"
 *     rather than an error, so the code is safe to deploy either side of
 *     migrations/2026-08-07-multi-agent-cc.sql.
 *
 * Callers gate on the template's `shared_with_agent` flag; this helper does not
 * check it. It must never be used for auth emails (activation / password reset)
 * — those carry a login link that only the client may see.
 */

// Same shape as the guard used when saving a lead email. Intentionally loose:
// we only need to catch the values that would make Resend reject the send.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function buildAgentCcList(opts: {
  /** Partner whose primary + additional contacts should be copied. */
  partnerId?: string | null;
  /** Deal whose per-file `cc_emails` should be copied. */
  dealId?: string | null;
  /**
   * Addresses to exclude — normally the To recipient(s), so the client never
   * shows up in their own CC line.
   */
  exclude?: (string | null | undefined)[];
}): Promise<string[]> {
  const { partnerId, dealId, exclude = [] } = opts;

  const collected: string[] = [];

  if (partnerId) {
    const { data: partner } = await supabaseAdmin
      .from("partners")
      .select("agent_email")
      .eq("id", partnerId)
      .eq("is_deleted", false)
      .maybeSingle();
    if (partner?.agent_email) collected.push(partner.agent_email);

    const { data: contacts, error: contactsErr } = await supabaseAdmin
      .from("partner_contacts")
      .select("email")
      .eq("partner_id", partnerId)
      .eq("is_deleted", false);
    if (contactsErr) {
      // PGRST205 = table not in schema cache, i.e. migration not applied yet.
      logger.warn(
        `[agentCc] partner_contacts unavailable (${contactsErr.code}) — using primary agent_email only. partner=${partnerId}`,
      );
    } else {
      for (const c of contacts ?? []) if (c.email) collected.push(c.email);
    }
  }

  if (dealId) {
    const { data: deal, error: dealErr } = await supabaseAdmin
      .from("deals")
      .select("cc_emails")
      .eq("id", dealId)
      .maybeSingle();
    if (dealErr) {
      logger.warn(
        `[agentCc] deals.cc_emails unavailable (${dealErr.code}) — skipping per-file CC. deal=${dealId}`,
      );
    } else {
      for (const e of deal?.cc_emails ?? []) if (e) collected.push(e);
    }
  }

  const excluded = new Set(
    exclude.map((e) => normalizeRecipientEmail(e).toLowerCase()).filter(Boolean),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of collected) {
    const email = normalizeRecipientEmail(raw);
    if (!email) continue;
    if (!EMAIL_RE.test(email)) {
      logger.warn(`[agentCc] dropping malformed CC address ${JSON.stringify(raw)}`);
      continue;
    }
    const key = email.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }

  return out;
}
