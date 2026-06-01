import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { consumeInvitationToken } from "@/lib/invitationToken";

export const dynamic = "force-dynamic";

// Within the 7-day window the click goes through to /set-password as
// usual. Past the window (or if the token is missing / Supabase errors),
// bounce the user to the customer portal login page with a reason query
// param so the portal can display a "link expired" banner. We do NOT
// land them on the admin panel — they're customers, not staff.
function expiredRedirect(reason: string) {
  const customerPortalUrl = (
    process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://dev.iclosed.ca"
  ).replace(/\/+$/, "");
  console.log(customerPortalUrl,"customerPortalUrl");
  const url = new URL(`${customerPortalUrl}/login`);
  url.searchParams.set("reason", "link_expired");
  url.searchParams.set("detail", reason);
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
    return expiredRedirect(consumed.reason);
  }

  const { type, email, redirectTo, userData } = consumed.data;

  // At click-time the user already exists in auth.users (created at send-time
  // by sendAuthEmailViaResend's first generateLink call). We always use
  // `recovery` — for both invite and reset — because:
  //   1. `invite` re-calls fail with "User already registered" on the existing
  //      row.
  //   2. `magiclink` (the previous workaround for invites) produced sessions
  //      with AMR="otp"; on those, the customer-portal's
  //      supabase.auth.updateUser({password}) on /set-password silently
  //      no-ops on Supabase's API for some project configs — the success
  //      screen would render but signInWithPassword later returned "Invalid
  //      login credentials" because the password hash hadn't actually
  //      changed. `recovery` produces a true recovery session (AMR="recovery")
  //      where password updates are always honored — this is the
  //      Supabase-blessed pattern for "set your password" flows.
  // Recovery works for unconfirmed accounts too; the verify step that
  // happens when the user follows the action_link itself confirms the email.
  // We *also* explicitly confirm the user up front via the admin API as a
  // belt-and-braces guarantee that the eventual signInWithPassword call
  // doesn't trip the "Email not confirmed" gate on projects that require it.
  try {
    const { data: lookup } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const target = lookup?.users?.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (target && !target.email_confirmed_at) {
      await supabaseAdmin.auth.admin.updateUserById(target.id, {
        email_confirm: true,
      });
    }
  } catch (confirmErr) {
    // Non-blocking — if the lookup/confirm fails we still try to mint the
    // recovery link below. The recovery flow itself usually confirms the
    // email, so this only matters for the email-confirmation gate.
    console.warn("[Activate] email_confirm bump failed (non-blocking):", confirmErr);
  }

  const { data: linkData, error: linkError } =
    await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });

  if (linkError || !linkData?.properties?.action_link) {
    console.error(
      `[Activate] Failed to mint Supabase action_link: ${
        linkError?.message ?? "no action_link returned"
      } email=${email} originalType=${type}`,
    );
    return expiredRedirect("error");
  }

  // userData is intentionally not re-applied here — it was already attached
  // to the user_metadata during the send-time generateLink({type:'invite'}).
  void userData;

  return NextResponse.redirect(linkData.properties.action_link, 302);
}
