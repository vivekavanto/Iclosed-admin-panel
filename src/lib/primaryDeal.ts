import supabaseAdmin from "./supabaseAdmin";

/**
 * Resolves the primary (root) deal id for a deal's co-purchaser/co-seller
 * family: deal → lead → root lead (parent_lead_id or self) → that lead's deal.
 * Falls back to the input dealId on any miss.
 *
 * The same walk is inlined in a few older call sites (api/admin/tasks,
 * api/admin/task-responses, completeApsTask). New code should import this.
 */
export async function resolvePrimaryDealId(dealId: string): Promise<string> {
  try {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("id", dealId)
      .single();

    if (deal?.lead_id) {
      const { data: lead } = await supabaseAdmin
        .from("leads")
        .select("id, parent_lead_id")
        .eq("id", deal.lead_id)
        .single();

      const rootLeadId = lead?.parent_lead_id ?? lead?.id;
      if (rootLeadId) {
        const { data: rootDeal } = await supabaseAdmin
          .from("deals")
          .select("id")
          .eq("lead_id", rootLeadId)
          .maybeSingle();
        if (rootDeal?.id) return rootDeal.id;
      }
    }
  } catch {
    // Non-blocking: fall back to dealId
  }
  return dealId;
}
