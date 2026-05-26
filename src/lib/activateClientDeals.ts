import supabaseAdmin from "./supabaseAdmin";

/**
 * Promote Inactive deals to Active for a client identified by lead_id,
 * client row id, or login email. Safe to call multiple times (idempotent).
 */
export async function activateClientDeals(opts: {
  leadId?: string | null;
  clientId?: string | null;
  email?: string | null;
}): Promise<{ activated: number; error?: string }> {
  const { leadId, clientId, email } = opts;
  let resolvedClientId = clientId ?? null;
  let resolvedLeadId = leadId ?? null;

  if (!resolvedClientId && email) {
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    resolvedClientId = client?.id ?? null;
  }

  if (!resolvedLeadId && resolvedClientId) {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("lead_id")
      .eq("client_id", resolvedClientId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    resolvedLeadId = deal?.lead_id ?? null;
  }

  const filters: string[] = [];
  if (resolvedLeadId) filters.push(`lead_id.eq.${resolvedLeadId}`);
  if (resolvedClientId) filters.push(`client_id.eq.${resolvedClientId}`);

  if (filters.length === 0) {
    return { activated: 0, error: "No lead_id, client_id, or email to resolve" };
  }

  const { data, error } = await supabaseAdmin
    .from("deals")
    .update({ status: "Active" })
    .eq("status", "Inactive")
    .or(filters.join(","))
    .select("id");

  if (error) {
    return { activated: 0, error: error.message };
  }

  return { activated: data?.length ?? 0 };
}
