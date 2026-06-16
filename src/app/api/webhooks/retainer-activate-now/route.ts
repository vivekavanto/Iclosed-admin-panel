import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { consumeInvitationToken } from "@/lib/invitationToken";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/retainer-activate-now
 *
 * Called by the customer portal when a just-signed party taps "Activate your
 * account" on the post-sign prompt. Public by construction (under
 * /api/webhooks/*).
 *
 * Auth: the retainer-sign `token` the portal already holds. lead_id + email
 * come from the validated token's stored scope.
 *
 * Reuses the SAME machinery as lead conversion (sendAuthEmailViaResend, type
 * 'invite'): it creates/surfaces the auth.users row, mints a 7-day invitation
 * token, and sends the "Activate Account" email. Crucially it also RETURNS the
 * activation URL so the portal can redirect the user straight into
 * /set-password without waiting for the email — one seamless step right after
 * signing.
 *
 * Body: { token: string }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { token?: string };

    const consumed = await consumeInvitationToken(body.token ?? "");
    if (!consumed.ok) {
      const status = consumed.reason === "expired" ? 410 : 401;
      return NextResponse.json(
        { success: false, error: `Invalid retainer token: ${consumed.reason}` },
        { status },
      );
    }
    if (consumed.data.type !== "retainer_sign") {
      return NextResponse.json(
        { success: false, error: "Token is not a retainer signing token" },
        { status: 401 },
      );
    }

    const ud = consumed.data.userData ?? {};
    const lead_id = String(ud.lead_id ?? "");
    if (!lead_id) {
      return NextResponse.json(
        { success: false, error: "Token missing lead scope" },
        { status: 400 },
      );
    }

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, email, client_id")
      .eq("id", lead_id)
      .maybeSingle();

    const targetEmail = lead?.email || consumed.data.email;
    if (!targetEmail) {
      return NextResponse.json(
        { success: false, error: "No email on file for this lead" },
        { status: 400 },
      );
    }

    // A returning customer may already have a portal account. In that case an
    // 'invite' generateLink fails with "User already registered", so fall back
    // to the 'login' path (recovery link) instead of erroring.
    let emailType: "invite" | "login" = "invite";
    if (lead?.client_id) {
      const { data: client } = await supabaseAdmin
        .from("clients")
        .select("auth_user_id")
        .eq("id", lead.client_id)
        .maybeSingle();
      if (client?.auth_user_id) emailType = "login";
    }

    const customerPortalUrl = (
      process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://dev.iclosed.ca"
    ).replace(/\/+$/, "");
    const redirectTo = `${customerPortalUrl}/api/auth/callback?next=/set-password`;

    const userData = {
      first_name: lead?.first_name ?? "",
      last_name: lead?.last_name ?? "",
      display_name: `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim(),
    };

    const result = await sendAuthEmailViaResend({
      type: emailType,
      email: targetEmail,
      redirectTo,
      userData,
      leadId: lead_id,
    });

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error ?? "Failed to start activation" },
        { status: 500 },
      );
    }

    // Link the freshly-created auth user to the client and clear the "deferred"
    // flag — they are activating now, so they should drop out of the reminder
    // set. Mirrors convertLead's auth_user_id linkage.
    if (result.userId && lead?.client_id) {
      await supabaseAdmin
        .from("clients")
        .update({ auth_user_id: result.userId })
        .eq("id", lead.client_id);
    }
    await supabaseAdmin
      .from("leads")
      .update({ account_activation_deferred: false })
      .eq("id", lead_id);

    return NextResponse.json({
      success: true,
      // Portal redirects the user here to set their password immediately.
      activate_url: result.actionLink ?? null,
      email_sent: !result.skipped,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Server error";
    console.error("POST /api/webhooks/retainer-activate-now error:", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
