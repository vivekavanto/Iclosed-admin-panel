import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { consumeInvitationToken } from "@/lib/invitationToken";

export const dynamic = "force-dynamic";

function expiredRedirect(req: NextRequest, reason: string) {
  const url = new URL("/activation-expired", req.url);
  url.searchParams.set("reason", reason);
  return NextResponse.redirect(url, 302);
}

/**
 * GET /api/auth/activate?token=...
 *
 * Validates a code-issued invitation token, mints a fresh Supabase
 * action_link, and 302-redirects the browser to it. The downstream
 * customer-portal /api/auth/callback?next=/set-password flow runs
 * exactly as it does today — only the URL entry point has moved into
 * this admin app so we can own the 7-day expiry.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";

  const consumed = await consumeInvitationToken(token);
  if (!consumed.ok) {
    return expiredRedirect(req, consumed.reason);
  }

  const { type, email, redirectTo, userData } = consumed.data;

  // At click-time the user already exists in auth.users (created at send-time
  // by sendAuthEmailViaResend's first generateLink call). Re-calling
  // generateLink({type:'invite'}) here returns "User already registered" /
  // similar — which we'd treat as an error and bounce to /activation-expired
  // (i.e. the admin panel). To produce a working set-password session we
  // mint a `magiclink` for invites (works for existing unconfirmed users)
  // and keep `recovery` as-is for password resets.
  const linkType: "magiclink" | "recovery" =
    type === "invite" ? "magiclink" : "recovery";

  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: linkType,
      email,
      options: { redirectTo },
    });

  if (linkError || !linkData?.properties?.action_link) {
    console.error(
      `[Activate] Failed to mint Supabase action_link: ${
        linkError?.message ?? "no action_link returned"
      } email=${email} originalType=${type} linkType=${linkType}`,
    );
    return expiredRedirect(req, "error");
  }

  // userData is intentionally not re-applied here — it was already attached
  // to the user_metadata during the send-time generateLink({type:'invite'}).
  void userData;

  return NextResponse.redirect(linkData.properties.action_link, 302);
}
