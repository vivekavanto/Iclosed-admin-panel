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
    .select("*, tasks(id, status, is_deleted, role_type, is_shared), leads(id, parent_lead_id, is_deleted, first_name, last_name, email, co_person_role, address_street, address_unit, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code, clients(id, auth_user_id, citizenship_status))")
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

  // ── Referral attribution ─────────────────────────────────────────────────
  // Resolve every linked partner in ONE query rather than per row — the detail
  // page can afford a lookup per deal, a list of every open file cannot.
  //
  // Soft-deleted partners are excluded, matching the detail page: a deleted
  // partner must not resurface as the file's agent. A deal still pointing at one
  // reads as unlinked here, which is also what the milestone-email CC does.
  const partnerIds = Array.from(
    new Set(
      deals
        .map((d) => (d as { partner_id?: unknown }).partner_id)
        .filter((id: unknown): id is string => typeof id === "string" && !!id),
    ),
  );
  const partnersById = new Map<string, Record<string, unknown>>();
  if (partnerIds.length > 0) {
    const { data: partners, error: partnersErr } = await supabase
      .from("partners")
      .select(
        "id, agent_name, agent_email, agent_phone, brokerage_type, brokerage_name, referral_code",
      )
      .in("id", partnerIds)
      .eq("is_deleted", false);
    if (partnersErr) {
      // Non-blocking: the Agent column falls back to the free-text intake name
      // rather than the whole list failing to load.
      logger.error("[admin/deals] partner lookup failed (non-blocking):", partnersErr);
    }
    for (const p of partners ?? []) partnersById.set(p.id, p);
  }

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

  // Every deal in a co-purchaser/co-seller family, keyed by the family's ROOT
  // lead id, so a primary row can count the whole file's tasks (below) rather
  // than only its own person's.
  const familyDealsByRootLead = new Map<string, any[]>();
  for (const deal of deals) {
    const lead = (deal as any).leads as any;
    const rootLeadId = lead?.parent_lead_id ?? lead?.id;
    if (!rootLeadId) continue;
    // Skip a co-client whose lead was soft-deleted: getFamilyDealIds (which the
    // tasks API uses) drops them, so counting their tasks here would put the
    // Steps count above what the panel and the deal page list.
    if (lead?.is_deleted) continue;
    const arr = familyDealsByRootLead.get(rootLeadId) ?? [];
    arr.push(deal);
    familyDealsByRootLead.set(rootLeadId, arr);
  }

  // ── Signing appointments ─────────────────────────────────────────────────
  // One query for every confirmed booking, grouped by deal_id. Bookings hang off
  // whichever family member's deal the client booked from, so a primary row
  // collects them across the whole family (below). Non-blocking: a failed lookup
  // leaves the Signing column blank rather than breaking the list.
  type SigningAppt = {
    id: string;
    deal_id: string | null;
    start_at: string;
    appointment_type: string | null;
    side: string | null;
  };
  const signingByDeal = new Map<string, SigningAppt[]>();
  const dealIdsForSigning = deals.map((d: any) => d.id).filter(Boolean);
  if (dealIdsForSigning.length > 0) {
    const { data: appts, error: apptsErr } = await supabase
      .from("signing_appointments")
      .select("id, deal_id, start_at, appointment_type, side")
      .in("deal_id", dealIdsForSigning)
      .eq("status", "confirmed")
      .order("start_at", { ascending: true });
    if (apptsErr) {
      logger.error("[admin/deals] signing appointment lookup failed (non-blocking):", apptsErr);
    }
    for (const a of (appts ?? []) as SigningAppt[]) {
      if (!a.deal_id) continue;
      const arr = signingByDeal.get(a.deal_id) ?? [];
      arr.push(a);
      signingByDeal.set(a.deal_id, arr);
    }
  }

  // Exclude soft-deleted tasks so the Steps count matches the deal-detail
  // page, the customer portal, and the pending-tasks panel — all of which
  // filter is_deleted=false. Without this, a soft-deleted (never-completed)
  // task inflates totalTasks, so a fully-completed file shows e.g. 9/11.
  //
  // Admin-role rows are excluded for the same reason: they are the office's
  // own records (the client's mirrored closing-cost estimate among them), not
  // steps the client has to work through, and counting them as a finished
  // step would flatter every file's progress.
  const isCountableTask = (t: any) =>
    !t.is_deleted && (t.role_type ?? "").toLowerCase() !== "admin";

  const result = deals.map((deal: any) => {
    const lead = deal.leads as any;
    const isCoPurchaser = !!lead?.parent_lead_id;

    // Steps count a FILE, not a person. The list hides co-client rows, so the
    // primary's count has to span the family — otherwise a 3-person file whose
    // 9 tasks the deal page lists reads as 1/5 here (one collapsed set).
    //
    // The counted set mirrors /api/admin/tasks?include_family=1 exactly, which
    // is what the deal page and the pending-tasks panel render: the primary's
    // SHARED tasks once (they are mirrored onto every family deal, so counting
    // each copy would multiply them) plus EVERY person's personal tasks.
    // A single-person file reduces to "all of its own tasks" — unchanged.
    const familyDeals =
      !isCoPurchaser && lead?.id
        ? familyDealsByRootLead.get(lead.id) ?? [deal]
        : [deal];
    const countedTasks = [
      ...((deal.tasks ?? []) as any[]).filter(
        (t) => isCountableTask(t) && t.is_shared === true,
      ),
      ...familyDeals.flatMap((d: any) =>
        ((d.tasks ?? []) as any[]).filter(
          (t) => isCountableTask(t) && t.is_shared !== true,
        ),
      ),
    ];
    const totalTasks = countedTasks.length;
    const completedTasks = countedTasks.filter(
      (t: any) => t.status === "Completed",
    ).length;

    const hasCoPurchasers = lead ? primaryLeadIds.has(lead.id) : false;

    // The file's confirmed signings, soonest first. A primary row spans the
    // family (like the Steps count); a co-client row is hidden from the list.
    const signingAppointments = familyDeals
      .flatMap((d: any) => signingByDeal.get(d.id) ?? [])
      .sort((a, b) => a.start_at.localeCompare(b.start_at))
      .map((a) => ({
        id: a.id,
        start_at: a.start_at,
        appointment_type: a.appointment_type,
        side: a.side,
      }));

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
      signing_appointments: signingAppointments,
      // The linked partner, or null. `referral_agent_*` stay on `rest` as the
      // free-text intake fallback the UI reads behind this.
      referral_partner: deal.partner_id
        ? (partnersById.get(deal.partner_id) ?? null)
        : null,
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
