import supabaseAdmin from "./supabaseAdmin";

/**
 * Finds all deal IDs in the same co-purchaser family as the given deal.
 * Returns an array including the original dealId.
 *
 * Flow: deal → lead → root lead (coalesce parent_lead_id or self)
 *       → all leads in family → all their deals
 */
export async function getFamilyDealIds(dealId: string): Promise<string[]> {
  try {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (!deal?.lead_id) return [dealId];

    const { data: lead } = await supabaseAdmin
      .from("leads")
      .select("id, parent_lead_id")
      .eq("id", deal.lead_id)
      .single();

    if (!lead) return [dealId];

    const rootLeadId = lead.parent_lead_id ?? lead.id;

    const { data: familyLeads } = await supabaseAdmin
      .from("leads")
      .select("id")
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

    if (!familyLeads || familyLeads.length <= 1) return [dealId];

    const { data: familyDeals } = await supabaseAdmin
      .from("deals")
      .select("id")
      .in("lead_id", familyLeads.map((l) => l.id));

    if (!familyDeals) return [dealId];
    return familyDeals.map((d) => d.id);
  } catch {
    return [dealId];
  }
}
