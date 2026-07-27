import { NextResponse } from "next/server";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";

const ALLOWED_ORIGINS = [
  "https://iclosed.ca",
  "https://www.iclosed.ca",
  "http://localhost:3000",
  "http://localhost:3001",
];

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

/**
 * OPTIONS /api/admin/reset-password
 * Handle CORS preflight request.
 */
export async function OPTIONS(req: Request) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
}

/**
 * POST /api/admin/reset-password
 *
 * Generates a Supabase password reset link and sends it via Resend
 * using the "Reset Password" template from the email_templates table.
 *
 * Called by the customer portal's "Forgot Password" flow.
 *
 * Body: { email: string }
 */
export async function POST(req: Request) {
  const headers = corsHeaders(req);

  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "reset-password" });
    if (blocked) return blocked;
    const body = JSON.parse(raw);
    const { email } = body as { email: string };

    if (!email) {
      return NextResponse.json(
        { success: false, error: "email is required" },
        { status: 400, headers },
      );
    }

    // SEC-007: throttle reset requests (5/hr per email, 30/hr per IP). On limit
    // we return the SAME generic message as a normal request, so the throttle
    // itself never reveals whether an account exists.
    const genericOk = NextResponse.json(
      { success: true, message: "If an account exists with this email, a reset link has been sent." },
      { headers },
    );
    const [emailOk, ipOk] = await Promise.all([
      rateLimitOk(`reset-pw:email:${email.toLowerCase()}`, 5, 3600),
      rateLimitOk(`reset-pw:ip:${requestIp(req)}`, 30, 3600),
    ]);
    if (!emailOk || !ipOk) {
      return genericOk;
    }

    const customerPortalUrl = (
      process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ??
      "https://iclosed.ca"
    ).replace(/\/+$/, "");

    const result = await sendAuthEmailViaResend({
      type: "recovery",
      email,
      redirectTo: `${customerPortalUrl}/api/auth/callback?next=/set-password`,
    });

    if (!result.success) {
      // Return generic message — don't leak whether the email exists
      console.error("[ResetPassword] Error:", result.error);
      return NextResponse.json(
        { success: true, message: "If an account exists with this email, a reset link has been sent." },
        { headers },
      );
    }

    return NextResponse.json(
      { success: true, message: "If an account exists with this email, a reset link has been sent." },
      { headers },
    );
  } catch (err: any) {
    console.error("POST /api/admin/reset-password error:", err);
    return NextResponse.json(
      { success: true, message: "If an account exists with this email, a reset link has been sent." },
      { headers },
    );
  }
}
