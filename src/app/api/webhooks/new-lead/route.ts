import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { activateClientDeals } from "@/lib/activateClientDeals";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";
import { sendAgentSignupEmail } from "@/lib/sendAgentSignupEmail";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";

/**
 * POST /api/webhooks/new-lead
 *
 * Customer-portal webhook called after a user's first login. Looks up the
 * lead by email (or lead_id) and triggers the welcome email. Idempotent —
 * the underlying lib short-circuits if `welcome_email_sent` is already true,
 * so this is safe even after the email has already been sent at intake or
 * conversion time.
 *
 * Body:
 *   { email: string }   — looks up lead by email
 *   or { lead_id: string }
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
    const blocked = guardServiceRequest(req, raw, { routeKey: "new-lead" });
    if (blocked) return blocked;
    const body = JSON.parse(raw);

    // Resolve to a lead_id
    let leadId: string | null = body.lead_id ?? null;

    if (!leadId && body.email) {
      const { data } = await supabaseAdmin
        .from("leads")
        .select("id")
        .eq("email", body.email)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!data) {
        return NextResponse.json(
          { success: false, error: "Lead not found for this email" },
          { status: 404 },
        );
      }
      leadId = data.id;
    }

    if (!leadId) {
      return NextResponse.json(
        { success: false, error: "email or lead_id required" },
        { status: 400 },
      );
    }

    const activateResult = await activateClientDeals({
      leadId,
      email: body.email ?? null,
    });
    if (activateResult.error) {
      console.warn(
        `[new-lead webhook] deal activation failed (non-blocking): ${activateResult.error}`,
      );
    }

    const result = await sendWelcomeEmail(leadId, { source: "first_login" });

    // Notify the client's referral agent/broker that their client signed up.
    // Non-blocking and idempotent (guarded by leads.agent_signup_email_sent):
    // a failure here must never break the client's login/welcome flow, and it
    // silently no-ops when the lead has no agent on file.
    try {
      const agentResult = await sendAgentSignupEmail(leadId, {
        source: "first_login",
      });
      if (!agentResult.success) {
        console.warn(
          `[new-lead webhook] agent signup email failed (non-blocking): ${agentResult.error}`,
        );
      }
    } catch (agentErr: any) {
      console.warn(
        `[new-lead webhook] agent signup email threw (non-blocking): ${agentErr?.message}`,
      );
    }

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: result.statusCode ?? 500 },
      );
    }

    if (result.alreadySent) {
      return NextResponse.json({
        success: true,
        already_sent: true,
        message: "Welcome email already sent previously",
      });
    }

    return NextResponse.json({
      success: true,
      message: "Welcome email sent",
      email_id: result.emailId,
      template_used: result.templateUsed,
    });
  } catch (err: any) {
    // SEC-012/CMP-008: full detail stays in the server log; the public webhook
    // response is generic so internal/DB error text isn't echoed to callers.
    console.error("POST /api/webhooks/new-lead error:", err);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 },
    );
  }
}
