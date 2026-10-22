// Shared shape and event keys for the admin notification feed.
//
// Isomorphic on purpose: the server-side raisers (notifyAllTasksComplete.ts,
// notifyClientSignup.ts) import supabaseAdmin, which throws in the browser, so
// the UI can't take its constants from them. Keeping the keys here lets both
// sides agree on the string without the client pulling in the service-role
// client.


/** Raised when a client and their co-party finish every client-visible task. */
export const ALL_TASKS_COMPLETE_TYPE = "deal.all_tasks_complete";

/** Raised when a client sends a message (portal chat or an emailed reply). */
export const CLIENT_MESSAGE_TYPE = "deal.client_message";

/** Raised when a client activates their customer-portal account. */
export const CLIENT_SIGNUP_TYPE = "client.signed_up";

/**
 * Raised when a brand-new lead completes intake on the customer portal.
 *
 * Written by the PORTAL (`iclosed_dev_web/src/lib/notifyNewLead.ts`), which
 * inserts straight into the shared `notifications` table — intake happens over
 * there and the admin app is never called at all, so hooking an admin code path
 * would mean this never fires. The key is therefore MIRRORED in the portal and
 * the two copies must stay in step, or the feed silently loses the rows.
 *
 * Distinct from CLIENT_SIGNUP_TYPE: that one fires much later, when an
 * already-converted client activates their portal login.
 */
export const NEW_LEAD_TYPE = "lead.created";

/** One row of /api/admin/notifications, with this admin's read state applied. */
export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  deal_id: string | null;
  // A lead.created row has no deal yet — the deal is only minted at conversion —
  // so the feed falls back to lead_id to decide where a click should land.
  lead_id: string | null;
  file_number: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read: boolean;
};

/**
 * Where clicking a notification should take the admin.
 *
 * Deal-scoped events open the file; a lead.created row has no deal yet, so it
 * opens the lead on the leads list instead (`?lead=` is how that page deep-links
 * its detail view). Returns null when there is nothing to open, which is why
 * both call sites check before pushing.
 */
export function notificationHref(n: {
  deal_id: string | null;
  lead_id: string | null;
  type?: string;
}): string | null {
  // A client message opens its conversation in the Inbox (lead_id = the file's root lead).
  if (n.type === CLIENT_MESSAGE_TYPE && n.lead_id) return `/admin/messages?c=${n.lead_id}`;
  if (n.deal_id) return `/admin/deals/${n.deal_id}`;
  if (n.lead_id) return `/admin/leads?lead=${n.lead_id}`;
  return null;
}
