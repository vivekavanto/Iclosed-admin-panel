import { NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { sendAgentSignupEmail } from "@/lib/sendAgentSignupEmail";
import { logger } from "@/lib/logger";
import {
  getNotifyState,
  linkReferralAgent,
  parsePartnerId,
} from "@/lib/referralAgent";

/**
 * Referral agent (partner) management for an EXISTING lead/file, driven from the
 * lead's Partner Details section.
 *
 *   PUT  /api/admin/leads/[id]/agent   { partnerId }  → link (null = unlink)
 *   POST /api/admin/leads/[id]/agent                  → send the agent the
 *                                                       "your client signed up"
 *                                                       notification
 *
 * The write itself lives in src/lib/referralAgent.ts, shared with the file-level
 * twin at /api/admin/deals/[id]/agent — see that module for why an agent is
 * always applied family-wide and why only `partners` rows may be linked.
 *
 * Gated by the admin auth middleware (src/middleware.ts).
 */

export const dynamic = "force-dynamic";

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
    const parsed = parsePartnerId(body);
    if ("error" in parsed) {
      return NextResponse.json(
        { success: false, error: parsed.error },
        { status: 400 },
      );
    }

    const result = await linkReferralAgent(id, parsed.partnerId);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const admin = await getActingAdmin();
    await recordAudit({
      action: parsed.partnerId ? "lead.agent.link" : "lead.agent.unlink",
      actorEmail: admin.email,
      actorUserId: admin.id,
      resourceType: "lead",
      resourceId: id,
      metadata: {
        partnerId: parsed.partnerId,
        partnerName: result.partner?.agent_name ?? null,
        leadsUpdated: result.leadsUpdated,
        dealsUpdated: result.dealsUpdated,
      },
      req,
    });

    const notify = parsed.partnerId
      ? await getNotifyState(id, result.partner)
      : { eligible: false, reason: null };

    return NextResponse.json({
      success: true,
      partner: result.partner,
      leadsUpdated: result.leadsUpdated,
      dealsUpdated: result.dealsUpdated,
      notify,
      warnings: result.warnings,
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
