import supabaseAdmin from "@/lib/supabaseAdmin";

/**
 * Shared resolver for the multi-party Personal Info / Upload Identification tasks.
 *
 * Given a single task, it builds the full transaction "family" roster (the
 * primary lead + every co-person) and, for each member, the equivalent task on
 * that member's own deal (same task_template_id, or same title + side as a
 * fallback). Each member carries that task's completion state.
 *
 * Ported from the customer portal (D:\iclosed_dev_web\src\lib\familyTaskTargets.ts)
 * so the admin's multi-party accordion resolves the same roster the portal does.
 * Family members are resolved strictly via the shared primary id
 * (`id = primary` OR `parent_lead_id = primary`).
 */

export function getCoPersonLabel(role: string | null): string {
  if (role === "purchaser") return "Co-Purchaser";
  if (role === "seller") return "Co-Seller";
  return "Co-Applicant";
}

export function getPrimaryLabel(
  side: "purchase" | "sale" | null,
  leadType: string | null
): string {
  if (side === "purchase") return "Primary Purchaser";
  if (side === "sale") return "Primary Seller";
  const lt = (leadType ?? "").toLowerCase();
  const isCombined = lt.includes("purchase") && lt.includes("sale");
  if (!isCombined && lt.includes("sale")) return "Primary Seller";
  if (!isCombined && lt.includes("purchase")) return "Primary Purchaser";
  return "Primary Applicant";
}

export interface FamilyTaskMember {
  lead_id: string;
  /** This member's own deal id (where their per-person task lives). */
  deal_id: string;
  /** The equivalent task on this member's own deal (null if none was found). */
  task_id: string | null;
  first_name: string;
  last_name: string;
  role_label: string;
  is_primary: boolean;
  is_self: boolean;
  /** Whether this member's copy of the task is completed. */
  completed: boolean;
}

export interface FamilyTaskRoster {
  task: {
    id: string;
    title: string;
    side: "purchase" | "sale" | null;
    deal_id: string;
    task_template_id: string | null;
    completed: boolean;
  };
  deal: { id: string; client_id: string | null; lead_id: string; type: string | null };
  /** Designated uploader for the family (submit_on_behalf === true), or null. */
  uploaderLeadId: string | null;
  /** The lead behind the opened task (deal.lead_id). */
  selfLeadId: string;
  /** Self first, then every other family member, each with their equivalent task. */
  members: FamilyTaskMember[];
}

/**
 * Resolves the family roster + equivalent tasks for the given opened task.
 * Returns null when the task or its deal cannot be found. Does NOT perform
 * authentication/ownership checks — the admin middleware already gates access.
 */
export async function getFamilyTaskRoster(
  taskId: string
): Promise<FamilyTaskRoster | null> {
  const { data: task } = await supabaseAdmin
    .from("tasks")
    .select("id, title, side, deal_id, task_template_id, completed")
    .eq("id", taskId)
    .maybeSingle();
  if (!task) return null;

  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("id, client_id, lead_id, type")
    .eq("id", task.deal_id)
    .maybeSingle();
  if (!deal) return null;

  const side = (task.side ?? null) as "purchase" | "sale" | null;

  // The "self" lead: the lead behind the opened task.
  const { data: selfLead } = await supabaseAdmin
    .from("leads")
    .select("id, first_name, last_name, parent_lead_id, submit_on_behalf, lead_type, co_person_role")
    .eq("id", deal.lead_id)
    .maybeSingle();

  const selfIsPrimary = !!selfLead && selfLead.parent_lead_id == null;
  const selfMember: FamilyTaskMember = {
    lead_id: selfLead?.id ?? deal.lead_id,
    deal_id: deal.id,
    task_id: task.id,
    first_name: selfLead?.first_name ?? "",
    last_name: selfLead?.last_name ?? "",
    role_label: selfIsPrimary
      ? getPrimaryLabel(side, selfLead?.lead_type ?? deal.type ?? null)
      : getCoPersonLabel(selfLead?.co_person_role ?? null),
    is_primary: selfIsPrimary,
    is_self: true,
    completed: !!task.completed,
  };

  // The family: primary lead + all its co-persons.
  const primaryId = selfLead?.parent_lead_id ?? selfLead?.id ?? deal.lead_id;
  const { data: familyLeads } = await supabaseAdmin
    .from("leads")
    .select("id, first_name, last_name, parent_lead_id, submit_on_behalf, lead_type, co_person_role")
    .or(`id.eq.${primaryId},parent_lead_id.eq.${primaryId}`);

  const uploader = (familyLeads ?? []).find((l) => l.submit_on_behalf === true);

  // Every OTHER family member + their equivalent task.
  const otherMembers = (familyLeads ?? []).filter((l) => l.id !== selfMember.lead_id);
  const others: FamilyTaskMember[] = [];

  for (const member of otherMembers) {
    const { data: memberDeal } = await supabaseAdmin
      .from("deals")
      .select("id")
      .eq("lead_id", member.id)
      .eq("is_deleted", false)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!memberDeal) continue;

    // Match the equivalent task on the member's own deal. task_template_id is the
    // authoritative cross-deal link (already side-specific). Fall back to a
    // same-side title match for legacy rows. Prefer an incomplete copy if several
    // exist.
    const baseQuery = () =>
      supabaseAdmin
        .from("tasks")
        .select("id, completed")
        .eq("deal_id", memberDeal.id)
        .eq("is_deleted", false)
        .order("completed", { ascending: true })
        .limit(1);

    let memberTask: { id: string; completed: boolean } | null = null;
    if (task.task_template_id) {
      const { data } = await baseQuery()
        .eq("task_template_id", task.task_template_id)
        .maybeSingle();
      memberTask = data ?? null;
    }
    if (!memberTask) {
      let q = baseQuery().ilike("title", task.title);
      q = side == null ? q.is("side", null) : q.eq("side", side);
      const { data } = await q.maybeSingle();
      memberTask = data ?? null;
    }
    if (!memberTask) continue;

    const memberIsPrimary = member.parent_lead_id == null;
    others.push({
      lead_id: member.id,
      deal_id: memberDeal.id,
      task_id: memberTask.id,
      first_name: member.first_name ?? "",
      last_name: member.last_name ?? "",
      role_label: memberIsPrimary
        ? getPrimaryLabel(side, member.lead_type ?? deal.type ?? null)
        : getCoPersonLabel(member.co_person_role ?? null),
      is_primary: memberIsPrimary,
      is_self: false,
      completed: !!memberTask.completed,
    });
  }

  return {
    task: {
      id: task.id,
      title: task.title,
      side,
      deal_id: task.deal_id,
      task_template_id: task.task_template_id ?? null,
      completed: !!task.completed,
    },
    deal,
    uploaderLeadId: uploader?.id ?? null,
    selfLeadId: selfMember.lead_id,
    members: [selfMember, ...others],
  };
}
