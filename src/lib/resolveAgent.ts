import supabaseAdmin from "./supabaseAdmin";

export type ResolvedAgent = { email: string; name: string };

/**
 * Resolves the agent from a SINGLE lead OR deal row's own fields (both tables
 * carry the same pair of referral columns).
 *
 * Two ways a row can carry an agent:
 *  1. A partner's referral code was applied → partner_id points at the partners
 *     master; partners.agent_email / agent_name is the agent.
 *  2. No code, an off-system agent was named → the free-text
 *     referral_agent_email / referral_agent_name.
 *
 * The linked partner wins; the free-text fields are the fallback. Soft-deleted
 * partners are ignored (the FK is ON DELETE SET NULL, but a soft delete only
 * flips is_deleted, so we filter it explicitly).
 */
async function resolveAgentForRow(row: any): Promise<ResolvedAgent | null> {
  if (row?.partner_id) {
    const { data: partner } = await supabaseAdmin
      .from("partners")
      .select("agent_email, agent_name")
      .eq("id", row.partner_id)
      .eq("is_deleted", false)
      .maybeSingle();
    const email = partner?.agent_email?.trim();
    if (email) return { email, name: (partner?.agent_name ?? "").trim() };
  }

  const freeText = (row?.referral_agent_email ?? "").trim();
  return freeText
    ? { email: freeText, name: (row?.referral_agent_name ?? "").trim() }
    : null;
}

/**
 * Resolves the agent from a lead's DEALS rather than the lead row.
 *
 * convertLead() copies the referral onto the deal, and an admin linking an
 * agent to an existing file edits the DEAL — so a file can legitimately carry
 * its agent on deals.partner_id while the lead row has none.
 */
async function resolveAgentFromDeals(leadId: string): Promise<ResolvedAgent | null> {
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("partner_id, referral_agent_email, referral_agent_name")
    .eq("lead_id", leadId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });

  for (const deal of deals ?? []) {
    const agent = await resolveAgentForRow(deal);
    if (agent) return agent;
  }
  return null;
}

/**
 * Resolves the client's referral agent/broker (name + email).
 *
 * Looks, in order: the lead's own referral → the lead's deal(s) → the parent
 * lead's referral → the parent lead's deal(s).
 *
 * Co-purchasers / co-sellers are stored as SEPARATE lead rows (parent_lead_id
 * set) and do NOT carry the referral link — it lives only on the primary lead.
 * So for a co-client we fall back to the parent, so the referring agent is
 * still found for every person on the file.
 *
 * Returns null when nothing in that chain has an agent on file — a normal,
 * non-error case (direct sign-ups have no referrer).
 */
export async function resolveAgent(lead: any): Promise<ResolvedAgent | null> {
  const own = await resolveAgentForRow(lead);
  if (own) return own;

  if (lead?.id) {
    const fromDeal = await resolveAgentFromDeals(lead.id);
    if (fromDeal) return fromDeal;
  }

  if (lead?.parent_lead_id) {
    const { data: parent } = await supabaseAdmin
      .from("leads")
      .select("id, partner_id, referral_agent_email, referral_agent_name")
      .eq("id", lead.parent_lead_id)
      .maybeSingle();
    if (parent) {
      const fromParent = await resolveAgentForRow(parent);
      if (fromParent) return fromParent;
      return resolveAgentFromDeals(parent.id);
    }
  }

  return null;
}

/** The extra placeholder values an agent-addressed email needs. */
export function agentTemplateValues(
  agent: ResolvedAgent | null,
  opts: { addressedToAgent: boolean },
): Record<string, string> {
  const name = agent?.name ?? "";
  const first = name.split(/\s+/)[0] ?? "";
  const last = name.split(/\s+/).slice(1).join(" ");
  const values: Record<string, string> = {
    agent_first_name: first,
    agent_name: name,
  };
  // When the agent is the recipient, user.* is the agent (as in agent-only
  // milestone mail); the client stays reachable via client.*.
  if (opts.addressedToAgent) {
    values["user.first_name"] = first;
    values["user.last_name"] = last;
    values["user.full_name"] = name;
    values["user.get_full_name"] = name;
    values["user.email"] = agent?.email ?? "";
  }
  return values;
}
