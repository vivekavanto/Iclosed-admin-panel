import supabaseAdmin from "./supabaseAdmin.ts";
import { normalizeRecipientEmail } from "./emailIdentity.ts";
import { logger } from "./logger.ts";

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
 *   4. the standing CC below         — staff copied on all agent-facing mail,
 *                                      and only when 1–3 put someone on the CC
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

/**
 * Staff copied on EVERY email an agent receives — whether the agent is the
 * recipient (agent signup, referral code) or merely CC'd on the client's mail.
 *
 * This is an oversight copy, not a file participant, which is why it lives here
 * as a constant rather than as a `partner_contacts` row per partner. Rows would
 * have to be repeated for every partner that exists, would be silently missing
 * for every partner created afterwards, and would make `partnerCcAddresses()`
 * report the address as one of that brokerage's own contacts — it would then
 * show on the deal page as a partner contact and be rejected as a duplicate
 * `cc_emails` entry. None of that is true of it.
 *
 * Override per deployment with `AGENT_CC_ALWAYS` (comma-separated). Setting it
 * to the EMPTY STRING turns the standing CC off entirely, so it can be removed
 * without a deploy — hence the `undefined` check rather than `|| DEFAULT`, which
 * would read "" as "unset" and make that kill switch impossible.
 */
const DEFAULT_STANDING_AGENT_CC = "saru@iclosed.ca";

function standingAgentCcAddresses(): string[] {
  const raw = process.env.AGENT_CC_ALWAYS;
  if (raw === undefined) return [DEFAULT_STANDING_AGENT_CC];
  return raw.split(",");
}

/**
 * Normalise, validate and de-dupe CC candidates, dropping anything excluded.
 *
 * Extracted so the standing CC passes through exactly the same guards as an
 * address read out of the database: a typo in `AGENT_CC_ALWAYS` is dropped and
 * logged like any other malformed CC, rather than making Resend reject the whole
 * send and take the client's email down with it.
 */
function sanitizeCcList(
  raws: (string | null | undefined)[],
  exclude: (string | null | undefined)[],
): string[] {
  const excluded = new Set(
    exclude.map((e) => normalizeRecipientEmail(e).toLowerCase()).filter(Boolean),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
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

/**
 * The standing CC for an email addressed TO an agent.
 *
 * For the two sends where the agent is the recipient rather than a copy —
 * `sendAgentSignupEmail` and `sendPartnerCodeEmail`. Neither has a partner or
 * deal whose contacts should be copied (the referral-code email is not about a
 * file at all), so they cannot use {@link buildAgentCcList}; they need only the
 * oversight copy. Pass the To address as `exclude` so an agent is never CC'd on
 * their own email.
 */
export function standingAgentCcList(
  exclude: (string | null | undefined)[] = [],
): string[] {
  return sanitizeCcList(standingAgentCcAddresses(), exclude);
}

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

  const out = sanitizeCcList(collected, exclude);

  // The standing CC rides along only when someone is ACTUALLY being copied.
  //
  // An empty list at this point means the file has no partner, no partner
  // contacts and no per-file `cc_emails` — nobody but the client is on this
  // email. Appending staff to it would turn a one-to-one client email into a
  // copied one, which is not what "CC on every email an agent receives" asks
  // for. Callers already gate on the template's `shared_with_agent` flag, so a
  // template that never reaches an agent never reaches here either.
  if (out.length > 0) {
    out.push(...sanitizeCcList(standingAgentCcAddresses(), [...exclude, ...out]));
  }

  return out;
}

/**
 * The agent side of a file as RECIPIENTS rather than copies.
 *
 * For "agent only" milestone emails (`email_templates.agent_only`), where the
 * referral agent is told something about their client's file and the client is
 * deliberately not on the email at all — not in `to`, not CC'd. Everything
 * {@link buildAgentCcList} would have copied goes into `to` instead; the
 * standing oversight address stays a CC, because it is watching the mail, not
 * receiving it.
 *
 * `agentName` is the partner's own `agent_name` — what an agent-facing template
 * greets. It is null for a file whose CC addresses come only from
 * `deals.cc_emails`, where nobody has a name on record.
 *
 * Returns an empty `to` when the file has no partner, no partner contacts and
 * no per-file CC addresses. That is a real outcome, not an error: an agent-only
 * email for a file with no agent has nobody to go to, and the caller reports it
 * rather than falling back to the client — which is exactly what this mode
 * exists to prevent.
 */
export async function buildAgentRecipients(opts: {
  partnerId?: string | null;
  dealId?: string | null;
  /** Addresses that must never receive this email — the file's clients. */
  exclude?: (string | null | undefined)[];
}): Promise<{ to: string[]; cc: string[]; agentName: string | null }> {
  const { partnerId, dealId, exclude = [] } = opts;

  const collected: string[] = [];
  let agentName: string | null = null;

  if (partnerId) {
    const { data: partner } = await supabaseAdmin
      .from("partners")
      .select("agent_name, agent_email")
      .eq("id", partnerId)
      .eq("is_deleted", false)
      .maybeSingle();
    if (partner?.agent_email) collected.push(partner.agent_email);
    if (partner?.agent_name) agentName = partner.agent_name;

    const { data: contacts, error: contactsErr } = await supabaseAdmin
      .from("partner_contacts")
      .select("email")
      .eq("partner_id", partnerId)
      .eq("is_deleted", false);
    if (contactsErr) {
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

  const to = sanitizeCcList(collected, exclude);
  // Same rule as buildAgentCcList: the standing copy rides along only when
  // somebody is actually being written to.
  const cc = to.length
    ? sanitizeCcList(standingAgentCcAddresses(), [...exclude, ...to])
    : [];

  return { to, cc, agentName };
}
