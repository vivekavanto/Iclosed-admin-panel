import { DealStatus } from "@/types";

// Single source of truth for the Active/Inactive/Closed badge shown for a deal.
//
// Active/Inactive is NOT read from the DB `status` column (which can be stale —
// the activate_deals_on_first_signin() trigger doesn't back-fill older/linked
// deals). It is derived from whether the client has signed into the portal:
// `account_created_at` actually holds the auth user's last_sign_in_at (see
// src/app/api/admin/deals/route.ts). "Closed" is the one explicit, admin-set
// DB state and always wins.
//
// Both the deal list badge and the edit-deal modal call this so they can never
// drift apart again.
export function computeDealDisplayStatus(
  deal: { status?: string | null; account_created_at?: string | null },
): DealStatus {
  if ((deal.status ?? "").toLowerCase() === "closed") return DealStatus.CLOSED;
  return deal.account_created_at ? DealStatus.ACTIVE : DealStatus.INACTIVE;
}
