import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { sendAgentSignupEmail } from "@/lib/sendAgentSignupEmail";
import { logger } from "@/lib/logger";

/**
 * Referral agent (partner) management for an EXISTING lead/file.
 *
 * Intake is the only place that could previously attach an agent: the client
 * applies a partner's referral code (leads.partner_id) or names an off-system
 * agent in free text (leads.referral_agent_*). When the agent isn't known at
 * intake time — the common case when staff fill the form on the client's behalf
 * — the file was stuck with no agent forever. These handlers close that gap.
 *
 *   PUT  /api/admin/leads/[id]/agent   { partnerId }  → link (null = unlink)
 *   POST /api/admin/leads/[id]/agent                  → send the agent the
 *                                                       "your client signed up"
 *                                                       notification
 *
 * Only partners already in the `partners` master can be linked — an off-system
 * agent must be created under Partners first. That keeps partner_id set, which
 * is what the milestone-email `shared_with_agent` CC, the agent signup email and
 * the Partners "clients referred" count all key off; free text would silently
 * do none of that.
 *
 * Gated by the admin auth middleware (src/middleware.ts).
 */

export const dynamic = "force-dynamic";

const PARTNER_COLUMNS =
  "id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name, referral_code";

// The partner shape the Leads UI already renders (same columns the leads GET
// attaches as `referral_partner`).
type PartnerRow = {
  id: string;
  agent_name: string | null;
  agent_email: string | null;
  agent_phone: string | null;
  brokerage_type: string | null;
  brokerage_name: string | null;
  referral_code: string | null;
};

// The four columns that carry referral attribution. Present on BOTH leads and
// deals with identical names, so one object drives both updates.
type AgentColumns = {
  partner_id: string | null;
  referral_agent_name: null;
  referral_agent_company: null;
  referral_agent_email: null;
};

/**
 * Resolves every lead in the same family (primary + co-purchasers/co-sellers).
 *
 * The agent referred the FILE, not one person — which is how convertLead()
 * already treats attribution when it copies the link onto each family deal — so
 * a late-added agent is applied family-wide too. It also keeps
 * sendAgentSignupEmail's per-lead resolution working for co-clients without
 * relying on its parent-lead fallback.
 */
async function getFamilyLeadIds(lead: {
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
async function getNotifyState(
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

// PUT /api/admin/leads/[id]/agent — link (or unlink) the referral partner for
// this lead's whole family, and mirror it onto their deals.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid lead id" },
        { status: 400 },
      );
    }

    const body: Record<string, unknown> = await req
      .json()
      .catch(() => ({}) as Record<string, unknown>);
    const rawPartnerId = body?.partnerId ?? null;
    // Explicit null (or "") clears the agent. Anything else must be a real id.
    const partnerId =
      rawPartnerId === null || rawPartnerId === "" ? null : rawPartnerId;
    if (partnerId !== null && !isUuid(partnerId)) {
      return NextResponse.json(
        { success: false, error: "Invalid partner id" },
        { status: 400 },
      );
    }

    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads")
      .select("id, parent_lead_id, is_deleted")
      .eq("id", id)
      .maybeSingle();
    if (leadErr) {
      logger.error("[lead agent] lead lookup failed:", leadErr);
      return NextResponse.json(
        { success: false, error: "Could not load the lead" },
        { status: 500 },
      );
    }
    if (!lead || lead.is_deleted) {
      return NextResponse.json(
        { success: false, error: "Lead not found" },
        { status: 404 },
      );
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
        return NextResponse.json(
          { success: false, error: "That partner no longer exists" },
          { status: 404 },
        );
      }
      partner = data;
    }

    const familyLeadIds = await getFamilyLeadIds(lead);

    // The free-text referral_agent_* fields are always cleared, whether we're
    // linking or unlinking. They exist only for the "client named an off-system
    // agent" intake path, and every reader treats them as a FALLBACK behind
    // partner_id — including sendAgentSignupEmail, which would otherwise mail
    // the superseded agent's address if the linked partner had none. Leaving
    // them would also make an unlink look like it silently failed, since the old
    // intake name would reappear in the Partner card.
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
      logger.error("[lead agent] leads update failed:", leadsErr);
      return NextResponse.json(
        { success: false, error: leadsErr.message },
        { status: 500 },
      );
    }

    // Mirror onto the family's deals so the file (deal detail page, milestone
    // email CC) sees the same agent. Non-fatal: the leads write is the source of
    // truth and is already committed, so a deals failure is reported as a
    // warning rather than rolling the admin back into an error state.
    const warnings: string[] = [];
    const { data: familyDeals, error: dealsSelectErr } = await supabaseAdmin
      .from("deals")
      .select("id")
      .in("lead_id", familyLeadIds)
      .eq("is_deleted", false);

    let dealCount = 0;
    if (dealsSelectErr) {
      logger.error("[lead agent] deals lookup failed:", dealsSelectErr);
      warnings.push(
        "Saved on the lead, but the linked file(s) could not be updated.",
      );
    } else if ((familyDeals ?? []).length > 0) {
      const dealIds = ((familyDeals ?? []) as { id: string }[]).map((d) => d.id);
      const { error: dealsErr } = await supabaseAdmin
        .from("deals")
        .update(agentColumns)
        .in("id", dealIds);
      if (dealsErr) {
        logger.error("[lead agent] deals update failed:", dealsErr);
        warnings.push(
          "Saved on the lead, but the linked file(s) could not be updated.",
        );
      } else {
        dealCount = dealIds.length;
      }
    }

    const admin = await getActingAdmin();
    await recordAudit({
      action: partnerId ? "lead.agent.link" : "lead.agent.unlink",
      actorEmail: admin.email,
      actorUserId: admin.id,
      resourceType: "lead",
      resourceId: id,
      metadata: {
        partnerId,
        partnerName: partner?.agent_name ?? null,
        leadsUpdated: familyLeadIds.length,
        dealsUpdated: dealCount,
      },
      req,
    });

    const notify = partnerId
      ? await getNotifyState(id, partner)
      : { eligible: false, reason: null };

    return NextResponse.json({
      success: true,
      partner,
      leadsUpdated: familyLeadIds.length,
      dealsUpdated: dealCount,
      notify,
      warnings,
    });
  } catch (err) {
    logger.error("[lead agent] PUT exception:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// POST /api/admin/leads/[id]/agent — manually send the agent the "your client
// signed up" notification. Only needed when the agent was linked after the
// client already activated, so the automatic one-shot never fired for them.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid lead id" },
        { status: 400 },
      );
    }

    // Deliberately NOT bypassing the idempotency guard: this is a catch-up for a
    // notification that never went out, not a re-send. sendAgentSignupEmail
    // reports alreadySent (success:true) if it did.
    const result = await sendAgentSignupEmail(id, { source: "manual" });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Failed to notify the agent" },
        { status: result.statusCode ?? 500 },
      );
    }

    if (result.alreadySent || result.skipped) {
      return NextResponse.json({
        success: true,
        sent: false,
        reason: result.alreadySent
          ? "The agent has already been notified."
          : (result.skipReason ?? "Nothing to send."),
      });
    }

    const admin = await getActingAdmin();
    await recordAudit({
      action: "lead.agent.notify",
      actorEmail: admin.email,
      actorUserId: admin.id,
      resourceType: "lead",
      resourceId: id,
      metadata: { emailId: result.emailId ?? null, template: result.templateUsed ?? null },
      req,
    });

    return NextResponse.json({ success: true, sent: true });
  } catch (err) {
    logger.error("[lead agent] POST exception:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
