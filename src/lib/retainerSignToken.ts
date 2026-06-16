import { createInvitationToken } from "./invitationToken";

export type RetainerSide = "purchase" | "sale" | null;

/**
 * Mint a "sign your retainer" link backed by the invitation_tokens table.
 *
 * The emitted URL points DIRECTLY at the customer portal's retainer agreement
 * page (no admin-app hop), carrying the 7-day token. The portal validates the
 * token against invitation_tokens (shared Supabase DB), reads lead_id/side from
 * user_data, and renders the retainer. The link expires only with the token.
 *
 * The portal path is configurable via NEXT_PUBLIC_PORTAL_RETAINER_PATH and
 * defaults to "/retainer".
 *
 * Returns { token, url } — the url is what goes in the email.
 */
export async function createRetainerSignToken(opts: {
  email: string;
  leadId: string;
  side: RetainerSide;
  primaryLeadId: string;
}): Promise<{ token: string; url: string }> {
  const { email, leadId, side, primaryLeadId } = opts;

  const customerPortalUrl = (
    process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "https://dev.iclosed.ca"
  ).replace(/\/+$/, "");
  const retainerPath =
    process.env.NEXT_PUBLIC_PORTAL_RETAINER_PATH || "/retainer";
  const portalRetainerUrl = `${customerPortalUrl}${
    retainerPath.startsWith("/") ? retainerPath : `/${retainerPath}`
  }`;

  // Persist the token + its scope. redirect_to records the portal page this
  // token is for. Retainer links don't have a short clock like invite/reset
  // emails — a client may take weeks to sign — so we give the token a ~10-year
  // (effectively non-expiring) lifetime.
  const { token } = await createInvitationToken({
    type: "retainer_sign",
    email,
    redirectTo: portalRetainerUrl,
    userData: {
      lead_id: leadId,
      side: side ?? "",
      primary_lead_id: primaryLeadId,
      kind: "retainer_sign",
    },
    ttlDays: 3650,
  });

  // The email link goes straight to the customer portal retainer page with the
  // token attached — the portal validates it and renders the agreement.
  const url = `${portalRetainerUrl}?token=${encodeURIComponent(token)}`;
  return { token, url };
}
