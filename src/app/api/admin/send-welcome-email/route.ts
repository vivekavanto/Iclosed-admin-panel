import { NextRequest, NextResponse } from "next/server";
import { sendWelcomeEmail } from "@/lib/sendWelcomeEmail";

/**
 * POST /api/admin/send-welcome-email
 *
 * Body: {
 *   lead_id: string,
 *   template_id?: string,
 *   template_name?: string,
 *   source?: "intake" | "conversion" | "first_login" | "manual"
 * }
 *
 * The welcome email is now triggered by multiple flows (intake submission,
 * lead conversion, first-login webhook, and this endpoint for manual admin
 * sends). The underlying lib uses the `welcome_email_sent` flag to keep the
 * send idempotent across all triggers.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { lead_id, template_id, template_name, source } = body as {
      lead_id?: string;
      template_id?: string;
      template_name?: string;
      source?: "intake" | "conversion" | "first_login" | "manual";
    };

    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "lead_id is required" },
        { status: 400 },
      );
    }

    const result = await sendWelcomeEmail(lead_id, {
      templateId: template_id,
      templateName: template_name,
      source: source ?? "manual",
    });

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

    if (result.skipped) {
      return NextResponse.json({
        success: true,
        skipped: true,
        message: result.skipReason ?? "Welcome email skipped",
        template_used: result.templateUsed,
      });
    }

    return NextResponse.json({
      success: true,
      message: "Welcome email sent",
      email_id: result.emailId,
      template_used: result.templateUsed,
    });
  } catch (err: any) {
    console.error("POST /api/admin/send-welcome-email error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
