// Shared shape and event keys for the admin notification feed.
//
// Isomorphic on purpose: the server-side raisers (notifyAllTasksComplete.ts,
// notifyClientSignup.ts) import supabaseAdmin, which throws in the browser, so
// the UI can't take its constants from them. Keeping the keys here lets both
// sides agree on the string without the client pulling in the service-role
// client.

/** Raised when a client and their co-party finish every client-visible task. */
export const ALL_TASKS_COMPLETE_TYPE = "deal.all_tasks_complete";

/** Raised when a client activates their customer-portal account. */
export const CLIENT_SIGNUP_TYPE = "client.signed_up";

/** One row of /api/admin/notifications, with this admin's read state applied. */
export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  deal_id: string | null;
  file_number: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  read: boolean;
};
