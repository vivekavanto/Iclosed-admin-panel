// Linking a referral agent (partner) to an existing file.
//
// Intake is the only place that could originally attach an agent: the client
// applies a partner's referral code (partner_id) or names an off-system agent in
// free text (referral_agent_*). When the agent isn't known at intake time — the
// common case when staff fill the form on the client's behalf — the file was
// stuck with no agent forever.
//
// Two entry points close that gap and BOTH land here, so they cannot drift:
//
//   /api/admin/leads/[id]/agent   from the lead's Partner Details section
//   /api/admin/deals/[id]/agent   from the All Files list
//
// They differ only in what the caller names the resource (a lead vs a file) and
// therefore in what the audit log records. The write itself is identical,
// because it is the same fact either way: the agent referred the FILE.
//
// Only partners already in the `partners` master can be linked — an off-system
// agent must be created under Partners first. That keeps partner_id set, which
// is what the milestone-email `shared_with_agent` CC, the agent signup email and
// the Partners "clients referred" count all key off; free text would silently do
// none of that.

import supabaseAdmin from "./supabaseAdmin";
import { isUuid } from "./isUuid";
import { logger } from "./logger";

/** The partner shape both the Leads and All Files UIs render. */
export const PARTNER_COLUMNS =
  "id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name, referral_code";

export type PartnerRow = {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  agent_phone: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
};

/**
 * The four columns that carry referral attribution. Present on BOTH leads and
 * deals with identical names, so one object drives both updates.
 */
type AgentColumns = {
  partner_id: string | null;
  referral_agent_name: null;
  referral_agent_company: null;
  referral_agent_email: null;
};

/**
 * Every lead in the same family (primary + co-purchasers/co-sellers).
 *
 * The agent referred the FILE, not one person — which is how convertLead()
 * already treats attribution when it copies the link onto each family deal — so
 * a late-added agent is applied family-wide too. It also keeps
 * sendAgentSignupEmail's per-lead resolution working for co-clients without
 * relying on its parent-lead fallback.
 */
export async function getFamilyLeadIds(lead: {
  id: string;
  parent_lead_id: string | null;
}): Promise<string[]> {
  const rootLeadId = lead.parent_lead_id ?? lead.id;
  if (!isUuid(rootLeadId)) return [lead.id];

  const { data: familyLeads } = await supabaseAdmin
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
    .eq("is_deleted", false);

  const ids = ((familyLeads ?? []) as { id: string }[]).map((l) => l.id);
  return ids.includes(lead.id) ? ids : [...ids, lead.id];
}

/**
 * Why the "notify agent" action is or isn't available for this lead.
 *
 * The notification normally fires once, automatically, when the client
 * activates their account. An agent linked AFTER that moment therefore missed
 * it permanently — so the admin gets a manual send, but only when it would
 * actually do something.
 */
export async function getNotifyState(
  leadId: string,
  partner: { agent_email?: string | null } | null,
): Promise<{ eligible: boolean; reason: string | null }> {
  if (!partner?.agent_email?.trim()) {
    return { eligible: false, reason: "This partner has no email address." };
  }

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("agent_signup_email_sent")
    .eq("id", leadId)
    .maybeSingle();

  if (lead?.agent_signup_email_sent) {
    return { eligible: false, reason: "The agent has already been notified." };
  }

  // Same activation gate sendAgentSignupEmail enforces internally: the client
  // has activated their account exactly when their deal leaves "Inactive".
  // Before that the automatic trigger still has its shot, so there's nothing to
  // catch up on.
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("status")
    .eq("lead_id", leadId);

  const activated = ((deals ?? []) as { status: string | null }[]).some(
    (d) => d.status && d.status !== "Inactive",
  );
  if (!activated) {
    return {
      eligible: false,
      reason:
        "The client hasn't activated their account yet — the agent is notified automatically when they do.",
    };
  }

  return { eligible: true, reason: null };
}

export type LinkReferralAgentResult =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      partner: PartnerRow | null;
      leadsUpdated: number;
      dealsUpdated: number;
      familyLeadIds: string[];
      warnings: string[];
    };

/**
 * Link (or, with `partnerId: null`, unlink) the referral partner for one lead's
 * whole family, and mirror it onto their deals.
 *
 * The caller is responsible for validating its own route param, for the audit
 * entry, and for resolving `notify` if it wants one — everything that differs
 * between the lead-level and file-level entry points.
 */
export async function linkReferralAgent(
  leadId: string,
  partnerId: string | null,
): Promise<LinkReferralAgentResult> {
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id, is_deleted")
    .eq("id", leadId)
    .maybeSingle();

  if (leadErr) {
    logger.error("[referral agent] lead lookup failed:", leadErr);
    return { ok: false, status: 500, error: "Could not load the lead" };
  }
  if (!lead || lead.is_deleted) {
    return { ok: false, status: 404, error: "Lead not found" };
  }

  // Resolve the partner up front so a stale/soft-deleted pick fails loudly
  // instead of writing an id that every reader then filters back out.
  let partner: PartnerRow | null = null;
  if (partnerId) {
    const { data } = await supabaseAdmin
      .from("partners")
      .select(PARTNER_COLUMNS)
      .eq("id", partnerId)
      .eq("is_deleted", false)
      .maybeSingle<PartnerRow>();
    if (!data) {
      return { ok: false, status: 404, error: "That partner no longer exists" };
    }
    partner = data;
  }

  const familyLeadIds = await getFamilyLeadIds(lead);

  // The free-text referral_agent_* fields are always cleared, whether we're
  // linking or unlinking. They exist only for the "client named an off-system
  // agent" intake path, and every reader treats them as a FALLBACK behind
  // partner_id — including sendAgentSignupEmail, which would otherwise mail the
  // superseded agent's address if the linked partner had none. Leaving them
  // would also make an unlink look like it silently failed, since the old intake
  // name would reappear in the Partner card.
  const agentColumns: AgentColumns = {
    partner_id: partnerId,
    referral_agent_name: null,
    referral_agent_company: null,
    referral_agent_email: null,
  };

  const { error: leadsErr } = await supabaseAdmin
    .from("leads")
    .update(agentColumns)
    .in("id", familyLeadIds);
  if (leadsErr) {
    logger.error("[referral agent] leads update failed:", leadsErr);
    return { ok: false, status: 500, error: leadsErr.message };
  }

  // Mirror onto the family's deals so the file (All Files list, deal detail
  // page, milestone email CC) sees the same agent. Non-fatal: the leads write is
  // the source of truth and is already committed, so a deals failure is reported
  // as a warning rather than rolling the admin back into an error state.
  const warnings: string[] = [];
  const { data: familyDeals, error: dealsSelectErr } = await supabaseAdmin
    .from("deals")
    .select("id")
    .in("lead_id", familyLeadIds)
    .eq("is_deleted", false);

  let dealCount = 0;
  if (dealsSelectErr) {
    logger.error("[referral agent] deals lookup failed:", dealsSelectErr);
    warnings.push("Saved on the lead, but the linked file(s) could not be updated.");
  } else if ((familyDeals ?? []).length > 0) {
    const dealIds = ((familyDeals ?? []) as { id: string }[]).map((d) => d.id);
    const { error: dealsErr } = await supabaseAdmin
      .from("deals")
      .update(agentColumns)
      .in("id", dealIds);
    if (dealsErr) {
      logger.error("[referral agent] deals update failed:", dealsErr);
      warnings.push("Saved on the lead, but the linked file(s) could not be updated.");
    } else {
      dealCount = dealIds.length;
    }
  }

  return {
    ok: true,
    partner,
    leadsUpdated: familyLeadIds.length,
    dealsUpdated: dealCount,
    familyLeadIds,
    warnings,
  };
}

/** Normalise a request body's `partnerId`: explicit null / "" clears the agent. */
export function parsePartnerId(
  body: Record<string, unknown>,
): { error: string } | { partnerId: string | null } {
  const raw = body?.partnerId ?? null;
  const partnerId = raw === null || raw === "" ? null : raw;
  if (partnerId !== null && !isUuid(partnerId)) {
    return { error: "Invalid partner id" };
  }
  return { partnerId: partnerId as string | null };
}
