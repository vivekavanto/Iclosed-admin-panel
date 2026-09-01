import supabaseAdmin from "@/lib/supabaseAdmin";
import { DEFAULT_FIRM_KEY, getFirm, resolveFirmKey, type FirmKey, type FirmProfile } from "@/lib/firms";
import { logger } from "@/lib/logger";

/**
 * Which firm a file belongs to — Nava Wilson or iClosed LLP.
 *
 * The label lives on `leads.firm_key`, and the ROOT lead of the family is
 * authoritative: pass ANY lead in the family (primary or a co-purchaser /
 * co-seller) and this follows `parent_lead_id` up to the primary and reads it
 * there. Same shape as getFamilyUploadMode.
 *
 * A file cannot be half Nava Wilson and half iClosed — co-clients on one
 * transaction are retained by ONE firm, sign ONE retainer wording and get mail
 * from ONE address. Reading the root rather than the row in hand is what makes
 * a co-client's welcome email match the primary's, even if a stray write left
 * the child row behind.
 *
 * ── Failure behaviour ───────────────────────────────────────────────────
 * Every path returns a firm; none throws. A lookup that fails (missing row,
 * a deploy that ran the code before the migration) resolves to
 * DEFAULT_FIRM_KEY = Nava Wilson, which is what every file was before this
 * feature existed. The alternative — letting a send blow up because a firm
 * could not be resolved — would trade a wrong logo for an email that never
 * arrives.
 */

/** Firm for any lead in a family, resolved from the ROOT lead. */
export async function getLeadFirmKey(anyFamilyLeadId: string | null | undefined): Promise<FirmKey> {
  if (!anyFamilyLeadId) return DEFAULT_FIRM_KEY;

  const { data: lead, error } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id, firm_key")
    .eq("id", anyFamilyLeadId)
    .maybeSingle();

  if (error || !lead) {
    if (error) logger.warn("[leadFirm] lead lookup failed", { leadId: anyFamilyLeadId, error: error.message });
    return DEFAULT_FIRM_KEY;
  }

  const rootId = lead.parent_lead_id ?? lead.id;
  // Already at the root — the row in hand carries the authoritative value.
  if (rootId === lead.id) return resolveFirmKey(lead.firm_key);

  const { data: root } = await supabaseAdmin
    .from("leads")
    .select("firm_key")
    .eq("id", rootId)
    .maybeSingle();

  // A child whose parent has been hard-deleted still has its own copy, kept in
  // step by the admin PUT handler; prefer it over silently defaulting.
  return resolveFirmKey(root?.firm_key ?? lead.firm_key);
}

/** Firm profile for any lead in a family. */
export async function getLeadFirm(anyFamilyLeadId: string | null | undefined): Promise<FirmProfile> {
  return getFirm(await getLeadFirmKey(anyFamilyLeadId));
}

/** Firm for a deal, via its lead. */
export async function getDealFirmKey(dealId: string | null | undefined): Promise<FirmKey> {
  if (!dealId) return DEFAULT_FIRM_KEY;

  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .eq("id", dealId)
    .maybeSingle();

  return getLeadFirmKey(deal?.lead_id ?? null);
}

/** Firm profile for a deal. */
export async function getDealFirm(dealId: string | null | undefined): Promise<FirmProfile> {
  return getFirm(await getDealFirmKey(dealId));
}

/**
 * Firm for a client (the portal login), via the client's root lead.
 *
 * A client can in principle hold several files. They are branded by the file,
 * not by the person, so this is only for the few sends that have a client and
 * no lead in hand — it takes the client's most recent non-deleted lead.
 */
export async function getClientFirmKey(clientId: string | null | undefined): Promise<FirmKey> {
  if (!clientId) return DEFAULT_FIRM_KEY;

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("id")
    .eq("client_id", clientId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return getLeadFirmKey(lead?.id ?? null);
}
