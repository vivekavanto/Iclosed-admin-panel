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

  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type,
      email,
      options: {
        redirectTo,
        ...(userData && type === "invite" ? { data: userData } : {}),
      },
    });

  if (linkError || !linkData?.properties?.action_link) {
    console.error(
      `[Activate] Failed to mint Supabase action_link: ${
        linkError?.message ?? "no action_link returned"
      } email=${email} type=${type}`,
    );
    return expiredRedirect(req, "error");
  }

  return NextResponse.redirect(linkData.properties.action_link, 302);
}
