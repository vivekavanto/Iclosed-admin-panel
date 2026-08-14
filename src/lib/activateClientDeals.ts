import supabaseAdmin from "./supabaseAdmin";

/**
 * Promote Inactive deals to Active for a client identified by lead_id,
 * client row id, or login email. Safe to call multiple times (idempotent).
 */
export async function activateClientDeals(opts: {
  leadId?: string | null;
  clientId?: string | null;
  email?: string | null;
}): Promise<{
  activated: number;
  leadId?: string | null;
  clientId?: string | null;
  error?: string;
}> {
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

  if (!resolvedLeadId && !resolvedClientId) {
    return { activated: 0, error: "No lead_id, client_id, or email to resolve" };
  }

  // Two single-column updates instead of one `.or(lead_id.eq.X,client_id.eq.Y)`.
  //
  // The combined form is NOT portable: on the production Supabase project that
  // exact PATCH fails with `42703: column deals.lead_id does not exist`, while
  // the identical query succeeds on dev and the same `.or()` works fine on a
  // SELECT — the two projects run different PostgREST versions, and the older
  // one renders an OR filter on UPDATE against a relation where the column
  // isn't in scope. That error made activateClientDeals return early with
  // `error` set on EVERY production call, so the activate-deal webhook 500'd
  // before it could notify the referral agent. Hence: no `.or()` on writes.
  //
  // Running both updates cannot double count — the first one flips the row off
  // "Inactive", so the second no longer matches it.
  const updatedIds = new Set<string>();
  const errors: string[] = [];

  for (const [column, value] of [
    ["lead_id", resolvedLeadId],
    ["client_id", resolvedClientId],
  ] as const) {
    if (!value) continue;
    const { data, error } = await supabaseAdmin
      .from("deals")
      .update({ status: "Active" })
      .eq("status", "Inactive")
      .eq(column, value)
      .select("id");
    if (error) {
      errors.push(`${column}: ${error.message}`);
      continue;
    }
    for (const row of data ?? []) updatedIds.add(row.id);
  }

  // Only a total failure is an error. If one column's update worked, the
  // activation happened and callers should carry on.
  if (errors.length > 0 && updatedIds.size === 0) {
    return {
      activated: 0,
      leadId: resolvedLeadId,
      clientId: resolvedClientId,
      error: errors.join("; "),
    };
  }

  // Surface the lead AND client we resolved so activation callbacks can chain
  // follow-up work (e.g. the "Signup email to agents" notification) without
  // re-resolving. The client id matters on its own: a lead is only found here
  // when a deal already carries client_id, so callers that must reach every
  // lead of this person fall back to the client id (or the email).
  return {
    activated: updatedIds.size,
    leadId: resolvedLeadId,
    clientId: resolvedClientId,
  };
}
