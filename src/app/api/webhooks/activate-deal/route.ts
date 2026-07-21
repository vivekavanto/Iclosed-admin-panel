import { NextRequest, NextResponse } from "next/server";
import { activateClientDeals } from "@/lib/activateClientDeals";
import { sendAgentSignupEmail } from "@/lib/sendAgentSignupEmail";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";

/**
 * POST /api/webhooks/activate-deal
 *
 * Called by the customer portal after account activation / set-password
 * (or first login). Flips Inactive → Active without relying on a DB trigger.
 *
 * Body: { email: string } | { lead_id: string } | { client_id: string }
 */
export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw);
    if (blocked) return blocked;
    const body = JSON.parse(raw);
    const { email, lead_id, client_id } = body as {
      email?: string;
      lead_id?: string;
      client_id?: string;
    };

    if (!email && !lead_id && !client_id) {
      return NextResponse.json(
        { success: false, error: "email, lead_id, or client_id required" },
        { status: 400 },
      );
    }

    const result = await activateClientDeals({
      email: email ?? null,
      leadId: lead_id ?? null,
      clientId: client_id ?? null,
    });

    if (result.error) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 },
      );
    }

    // Account is now activated (deal flipped to Active) — notify the client's
    // referral agent/broker. Non-blocking and idempotent (guarded by
    // leads.agent_signup_email_sent), and it internally re-checks the deal is
    // no longer Inactive, so a retry can't misfire. Silently no-ops when the
    // lead has no agent on file.
    const activatedLeadId = result.leadId ?? lead_id ?? null;
    if (activatedLeadId) {
      try {
        const agentResult = await sendAgentSignupEmail(activatedLeadId, {
          source: "first_login",
        });
        if (!agentResult.success) {
          console.warn(
            `[activate-deal webhook] agent signup email failed (non-blocking): ${agentResult.error}`,
          );
        }
      } catch (agentErr: unknown) {
        const m = agentErr instanceof Error ? agentErr.message : String(agentErr);
        console.warn(
          `[activate-deal webhook] agent signup email threw (non-blocking): ${m}`,
        );
      }
    }

    return NextResponse.json({
      success: true,
      activated: result.activated,
      message:
        result.activated > 0
          ? `Activated ${result.activated} deal(s)`
          : "No Inactive deals to activate (already Active or not found)",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("POST /api/webhooks/activate-deal error:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
