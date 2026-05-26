import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { activateClientDeals } from "@/lib/activateClientDeals";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";

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
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

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
    console.error("POST /api/webhooks/new-lead error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
