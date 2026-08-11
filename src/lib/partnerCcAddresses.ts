import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { normalizeRecipientEmail } from "./emailIdentity";
import { logger } from "./logger";

/**
 * The CC addresses a file inherits from its referral partner: the partner's own
 * `partners.agent_email` plus every row in `partner_contacts`.
 *
 * These are copied on the file's "Shared with agent" emails by
 * {@link buildAgentCcList}, but they live on the PARTNER, not the deal — one
 * partner's contacts apply to every file that partner referred. The deal page's
 * Email CC box edits `deals.cc_emails` only, so from that panel the partner's
 * addresses are invisible: an admin looking at an outbound email could see a CC
 * recipient that appears nowhere on the file, and re-adding that address to
 * `cc_emails` looked like the only way to "fix" it (which changes nothing — the
 * send-side helper de-dupes across all three sources).
 *
 * So this resolves them for two jobs: the deal GET returns them for display,
 * and the PATCH rejects an attempt to re-add one to `cc_emails`.
 *
 * Family-aware: `partner_id` is normally set only on the primary deal, while
 * `cc_emails` mirrors across the whole family, so a co-client's deal must
 * resolve the same partner as the primary's.
 *
 * Never throws — a lookup failure (or a `partner_contacts` table that predates
 * migrations/2026-08-07-multi-agent-cc.sql) returns fewer addresses rather than
 * blocking a legitimate save.
 */
export type PartnerCcAddress = {
  /** The address itself, normalised. */
  email: string;
  /** Brokerage/agent label for the partner it came from, for UI + messages. */
  partner: string;
  /** Which column it came from. */
  source: "agent_email" | "partner_contacts";
};

export async function partnerCcAddresses(dealId: string): Promise<PartnerCcAddress[]> {
  const out: PartnerCcAddress[] = [];
  const seen = new Set<string>();

  const push = (raw: string | null | undefined, partner: string, source: PartnerCcAddress["source"]) => {
    const email = normalizeRecipientEmail(raw);
    if (!email) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ email, partner, source });
  };

  try {
    const familyDealIds = await getFamilyDealIds(dealId);
    const { data: deals } = await supabaseAdmin
      .from("deals")
      .select("partner_id")
      .in("id", familyDealIds);

    const partnerIds = [
      ...new Set((deals ?? []).map((d) => d.partner_id).filter(Boolean)),
    ] as string[];
    if (partnerIds.length === 0) return out;

    const { data: partners } = await supabaseAdmin
      .from("partners")
      .select("id, brokerage_name, agent_name, agent_email")
      .in("id", partnerIds)
      .eq("is_deleted", false);

    const labels = new Map<string, string>();
    for (const p of partners ?? []) {
      const label = p.brokerage_name || p.agent_name || "the referral partner";
      labels.set(p.id, label);
      push(p.agent_email, label, "agent_email");
    }

    const { data: contacts, error: contactsErr } = await supabaseAdmin
      .from("partner_contacts")
      .select("partner_id, email")
      .in("partner_id", partnerIds)
      .eq("is_deleted", false);

    if (contactsErr) {
      logger.warn(
        `[partnerCcAddresses] partner_contacts unavailable (${contactsErr.code}) — agent_email only. deal=${dealId}`,
      );
    } else {
      for (const c of contacts ?? []) {
        push(c.email, labels.get(c.partner_id) ?? "the referral partner", "partner_contacts");
      }
    }
  } catch (err) {
    logger.warn(`[partnerCcAddresses] lookup failed for deal=${dealId}: ${err}`);
  }

  return out;
}
