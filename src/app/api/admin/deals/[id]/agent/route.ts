import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
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
 * Referral agent (partner) management addressed by FILE rather than by lead —
 * the All Files list works in files, so making it resolve a lead id first would
 * push a join into the UI for no benefit.
 *
 *   PUT  /api/admin/deals/[id]/agent   { partnerId }  → link (null = unlink)
 *   POST /api/admin/deals/[id]/agent                  → send the agent the
 *                                                       "your client signed up"
 *                                                       notification
 *
 * The write is the SAME operation as the lead-level twin at
 * /api/admin/leads/[id]/agent and shares its implementation in
 * src/lib/referralAgent.ts, so the two can never drift. Only the audit differs:
 * this records the file the admin was actually looking at, which is what makes
 * the trail match what they'd say they did.
 *
 * Gated by the admin auth middleware (src/middleware.ts).
 */

export const dynamic = "force-dynamic";

/**
 * The deal's lead, which is what referral attribution actually hangs off.
 *
 * A deal without a lead_id cannot be attributed: the family resolution, the
 * signup email and the Partners referral count all walk the lead. Bulk-imported
 * files are the case that hits this, so it fails with a message that says so
 * rather than a bare 404.
 */
async function resolveLeadId(
  dealId: string,
): Promise<{ error: string; status: number } | { leadId: string }> {
  const { data: deal, error } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, is_deleted")
    .eq("id", dealId)
    .maybeSingle();

  if (error) {
    logger.error("[deal agent] deal lookup failed:", error);
    return { error: "Could not load the file", status: 500 };
  }
  if (!deal || deal.is_deleted) {
    return { error: "File not found", status: 404 };
  }
  if (!deal.lead_id || !isUuid(deal.lead_id)) {
    return {
      error:
        "This file has no client record, so an agent cannot be attributed to it.",
      status: 409,
    };
  }
  return { leadId: deal.lead_id as string };
}

// PUT /api/admin/deals/[id]/agent — link (or unlink) the referral partner for
// this file, its client, and everyone else on the file.
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid file id" },
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

    const resolved = await resolveLeadId(id);
    if ("error" in resolved) {
      return NextResponse.json(
        { success: false, error: resolved.error },
        { status: resolved.status },
      );
    }

    const result = await linkReferralAgent(resolved.leadId, parsed.partnerId);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.status },
      );
    }

    const admin = await getActingAdmin();
    await recordAudit({
      action: parsed.partnerId ? "deal.agent.link" : "deal.agent.unlink",
      actorEmail: admin.email,
      actorUserId: admin.id,
      resourceType: "deal",
      resourceId: id,
      metadata: {
        partnerId: parsed.partnerId,
        partnerName: result.partner?.agent_name ?? null,
        leadId: resolved.leadId,
        leadsUpdated: result.leadsUpdated,
        dealsUpdated: result.dealsUpdated,
      },
      req,
    });

    const notify = parsed.partnerId
      ? await getNotifyState(resolved.leadId, result.partner)
      : { eligible: false, reason: null };

    return NextResponse.json({
      success: true,
      partner: result.partner,
      leadId: resolved.leadId,
      leadsUpdated: result.leadsUpdated,
      dealsUpdated: result.dealsUpdated,
      notify,
      warnings: result.warnings,
    });
  } catch (err) {
    logger.error("[deal agent] PUT exception:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

// POST /api/admin/deals/[id]/agent — catch-up send of the "your client signed
// up" notification, for an agent linked after the client already activated.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!isUuid(id)) {
      return NextResponse.json(
        { success: false, error: "Invalid file id" },
        { status: 400 },
      );
    }

    const resolved = await resolveLeadId(id);
    if ("error" in resolved) {
      return NextResponse.json(
        { success: false, error: resolved.error },
        { status: resolved.status },
      );
    }

    // Deliberately NOT bypassing the idempotency guard: this is a catch-up for a
    // notification that never went out, not a re-send.
    const result = await sendAgentSignupEmail(resolved.leadId, { source: "manual" });

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
      action: "deal.agent.notify",
      actorEmail: admin.email,
      actorUserId: admin.id,
      resourceType: "deal",
      resourceId: id,
      metadata: {
        leadId: resolved.leadId,
        emailId: result.emailId ?? null,
        template: result.templateUsed ?? null,
      },
      req,
    });

    return NextResponse.json({ success: true, sent: true });
  } catch (err) {
    logger.error("[deal agent] POST exception:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
