import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { sendAuthEmailViaResend } from "@/lib/sendAuthEmail";
import { logger } from "@/lib/logger";

/**
 * Send (or re-send) the customer-portal login email for one lead.
 *
 * Needed because `convertLead` only invites a co-person when the family's
 * upload_mode already made them responsible (see convert-lead route). When an
 * admin later reassigns that responsibility, the newly-responsible party has no
 * login — this route hands it to them. Same two-branch logic convertLead uses:
 *
 *   - already has an auth user → "login" email (login link + reset fallback)
 *   - no auth user yet         → "invite" email, and link the new auth user to
 *                                the clients row
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid lead id" }, { status: 400 });
  }

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id, first_name, last_name, email, client_id")
    .eq("id", id)
    .maybeSingle();

  if (!lead) {
    return NextResponse.json({ success: false, error: "Lead not found" }, { status: 404 });
  }

  const email = (lead.email as string | null)?.trim();
  if (!email) {
    return NextResponse.json(
      { success: false, error: "This person has no email address on file." },
      { status: 400 },
    );
  }
  if (!lead.client_id) {
    return NextResponse.json(
      {
        success: false,
        error:
          "This person has not been converted to a client yet, so there is no portal account to invite them to.",
      },
      { status: 400 },
    );
  }

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("id, auth_user_id")
    .eq("id", lead.client_id)
    .maybeSingle();

  const customerPortalUrl = (
    process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://www.iclosed.ca/"
  ).replace(/\/+$/, "");
  const redirectTo = `${customerPortalUrl}/api/auth/callback?next=/set-password`;

  const alreadyHasLogin = !!client?.auth_user_id;

  try {
    if (alreadyHasLogin) {
      const result = await sendAuthEmailViaResend({
        type: "login",
        email,
        redirectTo,
        leadId: lead.id as string,
      });
      if (!result.success) {
        return NextResponse.json(
          { success: false, error: result.error ?? "Could not send the login email." },
          { status: 400 },
        );
      }
    } else {
      const first = (lead.first_name as string | null) ?? "";
      const last = (lead.last_name as string | null) ?? "";
      const result = await sendAuthEmailViaResend({
        type: "invite",
        email,
        redirectTo,
        userData: {
          first_name: first,
          last_name: last,
          display_name: `${first} ${last}`.trim(),
        },
        leadId: lead.id as string,
      });
      if (!result.success || !result.userId) {
        return NextResponse.json(
          { success: false, error: result.error ?? "Could not send the invite email." },
          { status: 400 },
        );
      }
      await supabaseAdmin
        .from("clients")
        .update({ auth_user_id: result.userId })
        .eq("id", lead.client_id);
    }
  } catch (err) {
    logger.error("[portal-invite] send failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not send the email." },
      { status: 500 },
    );
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "lead.portal_invite",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead",
    resourceId: lead.id as string,
    metadata: { email, already_had_login: alreadyHasLogin },
    req,
  });

  return NextResponse.json({
    success: true,
    already_had_login: alreadyHasLogin,
    email,
  });
}
