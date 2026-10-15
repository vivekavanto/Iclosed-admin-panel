// In-app alert for the back office when a client activates their portal account.
//
// Raised from the /api/webhooks/activate-deal handler, which the customer
// portal already calls after set-password / first login. Hooking it there means
// this needs NO change in the portal repo — the signal is already arriving.
//
// In-app only, deliberately. The client's referral agent already gets an email
// at this moment (sendAgentSignupEmail), and a signup is a "good to know", not
// something staff must act on — unlike the all-tasks-complete alert, which
// emails as well. Keeping it out of the inbox is what makes the bell worth
// watching.
//
// Idempotency is the CALLER's: activate-deal only invokes this when
// activateClientDeals actually flipped deals Inactive → Active, and that update
// is itself conditional on the old status, so a retried webhook activates zero
// deals and raises no second notification.
//
// Best-effort by contract: never throws, so it can't break account activation.

import supabaseAdmin from "./supabaseAdmin";
import { buildLeadAddressPartsForEmail } from "./leadEmailAddress";
import { CLIENT_SIGNUP_TYPE } from "./notificationTypes";
import { logger } from "./logger";
import { isPendingFileNumber } from "./fileNumber";

export type NotifyClientSignupResult = {
  notified: boolean;
  reason?: "no_lead" | "no_deal" | "error";
};

function fullName(row: { first_name?: string | null; last_name?: string | null }): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

/**
 * Write the "your client just signed up" row into the notifications feed.
 *
 * @param leadId the lead whose account was activated
 */
export async function notifyClientSignup(
  leadId: string,
): Promise<NotifyClientSignupResult> {
  try {
    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("*")
      .eq("id", leadId)
      .maybeSingle();

    if (!lead) return { notified: false, reason: "no_lead" };

    // The bell links to a deal, so find this lead's. A co-person signing up
    // should still land the admin on their own file, hence lead_id not root.
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id, file_number")
      .eq("lead_id", leadId)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!deal) return { notified: false, reason: "no_deal" };

    const clientName = fullName(lead) || "A client";
    const addressParts = await buildLeadAddressPartsForEmail(lead);
    const propertyAddress =
      [addressParts.purchase, addressParts.selling].filter(Boolean).join(" and ") || "";

    // Same one-line-sentence shape as the all-tasks-complete title, so the
    // dropdown reads consistently.
    const title =
      `Your client ${clientName}${propertyAddress ? ` (${propertyAddress})` : ""} ` +
      `just signed up on iClosed.`;

    const { error } = await supabaseAdmin.from("notifications").insert({
      type: CLIENT_SIGNUP_TYPE,
      title,
      body: deal.file_number && !isPendingFileNumber(deal.file_number) ? `File ${deal.file_number} is now active.` : null,
      deal_id: deal.id,
      lead_id: leadId,
      file_number: deal.file_number ?? null,
      metadata: {
        client_name: clientName,
        property_address: propertyAddress,
        email: lead.email ?? null,
      },
    });

    if (error) {
      logger.error("[ClientSignup] failed to write in-app notification:", error);
      return { notified: false, reason: "error" };
    }

    logger.info(`[ClientSignup] notified — lead=${leadId} deal=${deal.id}`);
    return { notified: true };
  } catch (err) {
    logger.error(`[ClientSignup] unexpected failure for lead=${leadId}:`, err);
    return { notified: false, reason: "error" };
  }
}
