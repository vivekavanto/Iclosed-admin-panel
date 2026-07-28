import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";

const supabase = supabaseAdmin;


let authSignInCache: { at: number; map: Map<string, string> } | null = null;
const AUTH_CACHE_TTL_MS = 60_000;

async function getAuthSignInMap(): Promise<Map<string, string>> {
  if (authSignInCache && Date.now() - authSignInCache.at < AUTH_CACHE_TTL_MS) {
    return authSignInCache.map;
  }
  const map = new Map<string, string>();
  try {
    let page = 1;
    const perPage = 1000;
    while (true) {
      const { data: usersPage } = await supabase.auth.admin.listUsers({ page, perPage });
      const users = usersPage?.users ?? [];
      for (const u of users) {
        // last_sign_in_at stays NULL until the client first signs in — the
        // signal the "Account created" column wants.
        if (u.last_sign_in_at) map.set(u.id, u.last_sign_in_at);
      }
      if (users.length < perPage) break;
      page += 1;
    }
    authSignInCache = { at: Date.now(), map };
    return map;
  } catch (err) {
    logger.error("[admin/deals] listUsers failed (non-blocking):", err);
    // Fall back to a stale cache if we have one; otherwise an empty map.
    return authSignInCache?.map ?? map;
  }
}

export async function GET() {
  const { data, error } = await supabase
    .from("deals")
    .select("*, tasks(id, status, is_deleted), leads(id, parent_lead_id, first_name, last_name, email, co_person_role, address_street, address_unit, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code, clients(id, auth_user_id, citizenship_status))")
    .or("source.is.null,source.neq.bulk_import")
    .eq("is_deleted", false)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const deals = data ?? [];

  // Resolve "account created" timestamps from Supabase Auth. The All Files
  // list surfaces this so admins can see at a glance which clients have
  // actually signed up vs. who is still on the invite. Fetched in one
  // batch and mapped to each deal via leads.clients.auth_user_id.
  const authUserIds = new Set<string>();
  for (const deal of deals) {
    const lead = (deal as any).leads as any;
    const authId = lead?.clients?.auth_user_id;
    if (authId) authUserIds.add(authId);
  }
  // ARC-002: resolved from the cached auth sign-in map (see getAuthSignInMap)
  // instead of scanning the whole auth table on every request.
  const authCreatedAtMap =
    authUserIds.size > 0 ? await getAuthSignInMap() : new Map<string, string>();

  // Build a set of primary lead IDs that have co-purchasers pointing to them
  const primaryLeadIds = new Set<string>();
  for (const deal of deals) {
    const lead = deal.leads as any;
    if (lead?.parent_lead_id) {
      primaryLeadIds.add(lead.parent_lead_id);
    }
  }

  // Pull co-purchaser/co-seller names for each primary so the All Files
  // search haystack can match on a co-party's name (the co-* rows themselves
  // are hidden from the list, so without this their names are unreachable).
  const coPartyNamesByPrimaryLead = new Map<string, string[]>();
  if (primaryLeadIds.size > 0) {
    const { data: coLeads } = await supabase
      .from("leads")
      .select("first_name, last_name, parent_lead_id")
      .in("parent_lead_id", Array.from(primaryLeadIds));
    for (const cl of coLeads ?? []) {
      const name = `${cl.first_name ?? ""} ${cl.last_name ?? ""}`.trim();
      if (!name || !cl.parent_lead_id) continue;
      const arr = coPartyNamesByPrimaryLead.get(cl.parent_lead_id) ?? [];
      arr.push(name);
      coPartyNamesByPrimaryLead.set(cl.parent_lead_id, arr);
    }
  }

  const result = deals.map((deal: any) => {
    // Exclude soft-deleted tasks so the Steps count matches the deal-detail
    // page, the customer portal, and the pending-tasks panel — all of which
    // filter is_deleted=false. Without this, a soft-deleted (never-completed)
    // task inflates totalTasks, so a fully-completed file shows e.g. 9/11.
    const tasks = (deal.tasks ?? []).filter((t: any) => !t.is_deleted);
    const totalTasks = tasks.length;
    const completedTasks = tasks.filter((t: any) => t.status === "Completed").length;
    const lead = deal.leads as any;

    const isCoPurchaser = !!lead?.parent_lead_id;
    const hasCoPurchasers = lead ? primaryLeadIds.has(lead.id) : false;

    const { tasks: _tasks, leads: _leads, ...rest } = deal;
    const sellingPropertyAddress = lead
      ? [
          lead.selling_address_street,
          lead.selling_address_city,
          lead.selling_address_province,
          lead.selling_address_postal_code,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    // Combined purchase-side address from the lead. The deal's own
    // property_address is street-only; the structured parts (city /
    // province / postal) live on the lead — surfaced here so the deal
    // list can search by full address.
    const purchasePropertyAddress = lead
      ? [
          lead.address_street,
          lead.address_unit && `Unit ${lead.address_unit}`,
          lead.address_city,
          lead.address_province,
          lead.address_postal_code,
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    // Authoritative co-* role recorded at intake — "purchaser" or
    // "seller". The All Files list uses this to label the row badge
    // correctly instead of guessing from the deal's `type` field
    // (which can't disambiguate on Purchase & Sale parents where one
    // co-lead is the purchaser and another is the seller).
    const coPersonRole: "purchaser" | "seller" | null =
      lead?.co_person_role === "purchaser" || lead?.co_person_role === "seller"
        ? lead.co_person_role
        : null;
    const authUserId = lead?.clients?.auth_user_id ?? null;
    const accountCreatedAt = authUserId ? authCreatedAtMap.get(authUserId) ?? null : null;
    const coPartyNames =
      lead && !lead.parent_lead_id
        ? coPartyNamesByPrimaryLead.get(lead.id) ?? []
        : [];
    return {
      ...rest,
      totalTasks,
      completedTasks,
      auth_user_id: authUserId,
      is_co_purchaser: isCoPurchaser,
      has_co_purchasers: hasCoPurchasers,
      co_person_role: coPersonRole,
      co_party_names: coPartyNames,
      account_created_at: accountCreatedAt,
      lead_name: lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : null,
      // Intake email (leads.email, NOT NULL) — surfaced so the All Files list
      // can hide test accounts by the @navawilson.law domain and search by email.
      lead_email: lead?.email ?? null,
      // Citizenship sourced from the customer record (clients) — source of
      // truth for the non-citizen flag — falling back to the lead in transition.
      lead_citizenship_status: lead?.clients?.citizenship_status ?? null,
      selling_property_address: sellingPropertyAddress,
      purchase_property_address: purchasePropertyAddress,
      lead_address_city: lead?.address_city ?? null,
      lead_address_province: lead?.address_province ?? null,
      lead_address_postal_code: lead?.address_postal_code ?? null,
      lead_selling_address_city: lead?.selling_address_city ?? null,
      lead_selling_address_province: lead?.selling_address_province ?? null,
      lead_selling_address_postal_code: lead?.selling_address_postal_code ?? null,
    };
  });

  return NextResponse.json(result);
}
