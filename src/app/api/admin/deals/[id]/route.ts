import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

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
      // Step 1: Get the lead to find parent_lead_id
      const { data: lead } = await supabase
        .from("leads")
        .select("id, parent_lead_id, first_name, last_name")
        .eq("id", data.lead_id)
        .single();

      if (lead) {
        const rootLeadId = lead.parent_lead_id ?? lead.id;

        // Step 2: Find all leads in the family
        const { data: familyLeads } = await supabase
          .from("leads")
          .select("id, parent_lead_id, first_name, last_name")
          .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

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
                const dLead = leadMap.get(d.lead_id);
                const isPrimary = dLead ? !dLead.parent_lead_id : false;
                return {
                  id: d.id,
                  file_number: d.file_number,
                  property_address: d.property_address,
                  status: d.status,
                  lead_name: dLead
                    ? `${dLead.first_name ?? ""} ${dLead.last_name ?? ""}`.trim()
                    : null,
                  role: isPrimary ? "Primary Purchaser" : "Co-Purchaser",
                };
              });
            }
          }

          // Also determine the current deal's role
          const currentRole = lead.parent_lead_id
            ? "Co-Purchaser"
            : "Primary Purchaser";
          data.current_deal_role = currentRole;
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
