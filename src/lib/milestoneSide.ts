import supabaseAdmin from "./supabaseAdmin";

/**
 * Side scoping for milestone emails on Purchase & Sale files.
 *
 * A P&S family carries BOTH sides' milestones on every deal in the family, so a
 * purchase-side stage ("Title Search", "Financing Firm -> Mortgage
 * Instructions") completing used to email the co-sellers too. Milestone
 * COMPLETION was already side-safe — it mirrors by `stage_template_id`, and the
 * Purchase and Sale stage templates are different rows — but the email fan-out
 * sat outside that guard and just looped the whole family.
 *
 * Two rules, deliberately conservative in the same way as the retainer
 * attachment scoping in /api/admin/send-lead-family-email:
 *   • An unknown side on EITHER end means "no opinion" → still send. We only
 *     ever suppress an email when both sides are known and genuinely disagree.
 *   • The primary client on a P&S file is BOTH purchaser and seller (they have
 *     no `co_person_role` and no `parent_lead_id`), so they always receive both
 *     sides.
 */

export type Side = "purchase" | "sale";

/**
 * The side a milestone belongs to, or null when it isn't side-specific.
 *
 * `milestones.side` is only populated by the PORTAL's converter and only for
 * `Purchase & Sale` deals — the admin converter never writes it, so it is NULL
 * on the large majority of rows. Filtering on that column alone would therefore
 * silently do nothing. The authoritative source is the stage template's
 * `lead_type`; `milestones.side` is used only as a fast path when present.
 */
export async function resolveMilestoneSide(milestone: {
  side?: string | null;
  stage_template_id?: string | null;
}): Promise<Side | null> {
  const direct = (milestone.side ?? "").toLowerCase().trim();
  if (direct === "purchase" || direct === "sale") return direct;

  if (!milestone.stage_template_id) return null;

  const { data: stage } = await supabaseAdmin
    .from("stage_templates")
    .select("lead_type")
    .eq("id", milestone.stage_template_id)
    .maybeSingle();

  return leadTypeToSide(stage?.lead_type);
}

/**
 * The side a deal's client should receive, or null for "both / unknown".
 *
 * Primary clients return null on purpose: on a P&S file they are the purchaser
 * AND the seller, so every milestone concerns them.
 */
export async function resolveDealRecipientSide(dealId: string): Promise<Side | null> {
  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .eq("id", dealId)
    .maybeSingle();

  if (!deal?.lead_id) return null;

  const { data: lead } = await supabaseAdmin
    .from("leads")
    .select("parent_lead_id, co_person_role, lead_type")
    .eq("id", deal.lead_id)
    .maybeSingle();

  return resolveLeadRecipientSide(lead);
}

/** Same rule as {@link resolveDealRecipientSide}, for an already-fetched lead. */
export function resolveLeadRecipientSide(
  lead:
    | {
        parent_lead_id?: string | null;
        co_person_role?: string | null;
        lead_type?: string | null;
      }
    | null
    | undefined,
): Side | null {
  if (!lead) return null;
  // Primary client — both sides of the file are theirs.
  if (!lead.parent_lead_id) return null;

  const role = (lead.co_person_role ?? "").toLowerCase().trim();
  if (role === "purchaser") return "purchase";
  if (role === "seller") return "sale";

  // Legacy co-leads predate co_person_role. Intake copies the parent's
  // lead_type verbatim onto co-people, so a combined lead_type tells us
  // nothing — only a single-sided one is a usable signal.
  return leadTypeToSide(lead.lead_type);
}

function leadTypeToSide(rawLeadType: string | null | undefined): Side | null {
  const lt = (rawLeadType ?? "").toLowerCase().trim();
  const isCombined = lt.includes("purchase") && lt.includes("sale");
  if (isCombined) return null;
  if (lt.includes("sale")) return "sale";
  if (lt.includes("purchase")) return "purchase";
  // Refinance, Condo, blank, … — not side-specific.
  return null;
}

/**
 * Should this recipient get this milestone's email?
 *
 * Only suppresses when both sides are known and differ, so an unrecognised
 * lead_type or an unmapped stage template can never silently drop a client's
 * email — the failure mode is an extra email, never a missing one.
 */
export function shouldEmailForSide(
  milestoneSide: Side | null,
  recipientSide: Side | null,
): boolean {
  if (!milestoneSide || !recipientSide) return true;
  return milestoneSide === recipientSide;
}
