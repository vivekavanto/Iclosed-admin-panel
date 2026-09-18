import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { activateClientDeals } from "@/lib/activateClientDeals";
import { sendAgentSignupEmail } from "@/lib/sendAgentSignupEmail";
import { notifyClientSignup } from "@/lib/notifyClientSignup";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { findRowsByEmail } from "@/lib/emailLookup";

/**
 * Every lead row this activation refers to.
 *
 * activateClientDeals() resolves at most ONE lead, and only via a deal that
 * already carries client_id — so on a file where the deal was created before
 * the client existed (or where the person has several leads) the agent
 * notification used to be skipped entirely. Widen the lookup: the resolved
 * lead, the caller-supplied lead_id, every lead linked to the client, and every
 * lead with this login email. sendAgentSignupEmail is idempotent per lead, so
 * covering more rows can't produce duplicate emails.
 */
async function resolveLeadsToNotify(opts: {
  leadId?: string | null;
  clientId?: string | null;
  email?: string | null;
}): Promise<string[]> {
  const ids = new Set<string>();
  if (opts.leadId) ids.add(opts.leadId);

  if (opts.clientId) {
    const { data } = await supabaseAdmin
      .from("leads")
      .select("id")
      .eq("client_id", opts.clientId)
      .limit(20);
    for (const row of data ?? []) ids.add(row.id);
  }

  if (opts.email) {
    // A wildcard-free .ilike() is an EXACT (case-insensitive) match, so it
    // missed any lead whose stored address carried a stray space — the client
    // signed up, nothing resolved here, and the agent was never told. The
    // helper trims both sides. See emailLookup.ts.
    const rows = await findRowsByEmail<{ id: string }>("leads", "id", opts.email, {
      limit: 20,
    });
    for (const row of rows) ids.add(row.id);
  }

  return [...ids];
}

/**
 * POST /api/webhooks/activate-deal
 *
 * Called by the customer portal after account activation / set-password
 * (or first login). Flips Inactive → Active without relying on a DB trigger.
 *
 * Body: { email: string } | { lead_id: string } | { client_id: string }
 */
// SEC-017: this webhook is server-to-server only. It exposes NO CORS grant (no
// Access-Control-Allow-Origin), so a browser on another origin cannot call it.
// Answer preflight with 405 to make the "no cross-origin browser access" policy
// explicit rather than relying on the framework default.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "activate-deal" });
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

    // A failed activation is logged but must NOT short-circuit the rest of this
    // handler. It used to return 500 right here, which meant one broken UPDATE
    // silently took the agent notification down with it — the two are
    // independent, and the deal is usually Active already anyway (the
    // activate_deals_on_first_signin trigger).
    if (result.error) {
      console.warn(
        `[activate-deal webhook] deal activation failed (non-blocking): ${result.error}`,
      );
    }

    // Tell the back office, in-app only, that this client is now on the portal.
    // Gated on `activated > 0` so it fires exactly once: activateClientDeals'
    // UPDATE is conditional on status = 'Inactive', so a retried webhook flips
    // nothing and raises no duplicate. Never blocks activation.
    const activatedLeadId = result.leadId ?? lead_id ?? null;
    if (activatedLeadId && result.activated > 0) {
      try {
        await notifyClientSignup(activatedLeadId);
      } catch (notifyErr: unknown) {
        const m = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
        console.warn(
          `[activate-deal webhook] signup notification threw (non-blocking): ${m}`,
        );
      }
    }

    // Account is now activated — notify the client's referral agent/broker.
    // Non-blocking and idempotent (guarded by leads.agent_signup_email_sent),
    // and it internally re-checks the deal is no longer Inactive, so a retry
    // can't misfire. Silently no-ops when the lead has no agent on file.
    //
    // Note this runs even when `activated === 0`: a deal is often already
    // Active by the time we get here (the activate_deals_on_first_signin
    // trigger flips it the moment the client's auth session is created), and
    // "nothing left to flip" must not mean "don't tell the agent".
    const leadsToNotify = await resolveLeadsToNotify({
      leadId: result.leadId ?? lead_id ?? null,
      clientId: result.clientId ?? client_id ?? null,
      email: email ?? null,
    });
    for (const notifyLeadId of leadsToNotify) {
      try {
        const agentResult = await sendAgentSignupEmail(notifyLeadId, {
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
      notified: leadsToNotify.length,
      ...(result.error ? { activation_error: result.error } : {}),
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
