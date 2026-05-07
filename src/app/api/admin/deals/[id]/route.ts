import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

const supabase = supabaseAdmin;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { data, error } = await supabase
    .from("deals")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── Fetch linked deals (co-purchaser relationships) ──────────────────────
  let linked_deals: any[] = [];

  try {
    if (data.lead_id) {
      // Step 1: Get the lead to find parent_lead_id and selling-side address
      const { data: lead } = await supabase
        .from("leads")
        .select("id, parent_lead_id, first_name, last_name, citizenship_status, lead_type, selling_address_street, selling_address_city, selling_address_province, selling_address_postal_code")
        .eq("id", data.lead_id)
        .single();

      if (lead) {
        data.lead_citizenship_status = lead.citizenship_status ?? null;
        data.selling_property_address = [
          lead.selling_address_street,
          lead.selling_address_city,
          lead.selling_address_province,
          lead.selling_address_postal_code,
        ]
          .filter(Boolean)
          .join(", ");
        const rootLeadId = lead.parent_lead_id ?? lead.id;

        // Step 2: Find all leads in the family
        const { data: familyLeads } = await supabase
          .from("leads")
          .select("id, parent_lead_id, first_name, last_name, lead_type")
          .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

        // Determine a co-lead's role from its own lead_type when specific
        // (Purchase/Sale). Falls back to the deal's type for ambiguous cases.
        const dealTypeLower = (data.type ?? "").toLowerCase().trim();
        const dealIsSaleOnly = dealTypeLower === "sale";
        const labelForCo = (leadType: string | null | undefined): string => {
          const lt = (leadType ?? "").toLowerCase().trim();
          if (lt === "purchase") return "Co-Purchaser";
          if (lt === "sale") return "Co-Seller";
          return dealIsSaleOnly ? "Co-Seller" : "Co-Purchaser";
        };
        const labelForPrimary = (leadType: string | null | undefined): string => {
          const lt = (leadType ?? "").toLowerCase().trim();
          if (lt.includes("purchase") && lt.includes("sale")) return "Primary Client";
          if (lt === "sale") return "Primary Seller";
          if (lt === "purchase") return "Primary Purchaser";
          return dealIsSaleOnly ? "Primary Seller" : "Primary Purchaser";
        };

        if (familyLeads && familyLeads.length > 1) {
          // Get all family lead IDs except the current deal's lead
          const otherLeadIds = familyLeads
            .filter((l) => l.id !== lead.id)
            .map((l) => l.id);

          if (otherLeadIds.length > 0) {
            // Step 3: Find deals for those leads
            const { data: otherDeals } = await supabase
              .from("deals")
              .select("id, file_number, property_address, lead_id, status")
              .in("lead_id", otherLeadIds);

            if (otherDeals) {
              // Build a map of lead_id → lead info
              const leadMap = new Map(
                familyLeads.map((l) => [l.id, l])
              );

              linked_deals = otherDeals.map((d) => {
                const dLead = leadMap.get(d.lead_id) as any;
                const isPrimary = dLead ? !dLead.parent_lead_id : false;
                const role = isPrimary
                  ? labelForPrimary(dLead?.lead_type)
                  : labelForCo(dLead?.lead_type);
                return {
                  id: d.id,
                  file_number: d.file_number,
                  property_address: d.property_address,
                  status: d.status,
                  lead_name: dLead
                    ? `${dLead.first_name ?? ""} ${dLead.last_name ?? ""}`.trim()
                    : null,
                  role,
                };
              });
            }
          }

          // Also determine the current deal's role
          data.current_deal_role = lead.parent_lead_id
            ? labelForCo(lead.lead_type)
            : labelForPrimary(lead.lead_type);
        }
      }
    }
  } catch (err) {
    // Non-blocking — don't fail the whole request
    console.error("[DealDetail] Failed to fetch linked deals:", err);
  }

  return NextResponse.json({ ...data, linked_deals });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const { error } = await supabase
    .from("deals")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
