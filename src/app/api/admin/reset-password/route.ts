import { NextResponse } from "next/server";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";

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
  try {
    const body = await req.json();
    const { email } = body as { email: string };

    if (!email) {
      return NextResponse.json(
        { success: false, error: "email is required" },
        { status: 400 },
      );
    }

    const customerPortalUrl = (
      process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ??
      "https://iclosed-customer-application-rosy.vercel.app"
    ).replace(/\/+$/, "");

    const result = await sendAuthEmailViaResend({
      type: "recovery",
      email,
      redirectTo: `${customerPortalUrl}/api/auth/callback?next=/set-password`,
    });

    if (!result.success) {
      // Return generic message — don't leak whether the email exists
      console.error("[ResetPassword] Error:", result.error);
      return NextResponse.json({
        success: true,
        message: "If an account exists with this email, a reset link has been sent.",
      });
    }

    return NextResponse.json({
      success: true,
      message: "If an account exists with this email, a reset link has been sent.",
    });
  } catch (err: any) {
    console.error("POST /api/admin/reset-password error:", err);
    return NextResponse.json({
      success: true,
      message: "If an account exists with this email, a reset link has been sent.",
    });
  }
}
