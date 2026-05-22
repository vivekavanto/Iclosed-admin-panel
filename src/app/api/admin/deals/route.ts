import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET() {
  const { data, error } = await supabase
    .from("deals")
    .select("*, tasks(id, status), leads(id, parent_lead_id, first_name, last_name, citizenship_status, co_person_role, address_street, address_unit, address_city, address_province, address_postal_code, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code)")
    .or("source.is.null,source.neq.bulk_import")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const deals = data ?? [];

  // Build a set of primary lead IDs that have co-purchasers pointing to them
  const primaryLeadIds = new Set<string>();
  for (const deal of deals) {
    const lead = deal.leads as any;
    if (lead?.parent_lead_id) {
      primaryLeadIds.add(lead.parent_lead_id);
    }
  }

  const result = deals.map((deal: any) => {
    const tasks = deal.tasks ?? [];
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
    return {
      ...rest,
      totalTasks,
      completedTasks,
      is_co_purchaser: isCoPurchaser,
      has_co_purchasers: hasCoPurchasers,
      co_person_role: coPersonRole,
      lead_name: lead ? `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() : null,
      lead_citizenship_status: lead?.citizenship_status ?? null,
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
