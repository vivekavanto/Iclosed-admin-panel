import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";

/**
 * Resolves the set of `tasks.id`s that should be kept in lockstep with a given
 * shared task across the deal's co-purchaser / co-seller family.
 *
 * Why this exists: shared tasks are mirrored by `task_template_id`, but two
 * parties on the SAME side may carry different template ids for the same-named
 * task. A case-insensitive title match within the family bridges that without
 * changing the data model.
 *
 * SIDE-ISOLATED: the title fallback only matches peers on the same `side` as
 * the source task. "Status of Mortgage" and "Schedule an Appointment" exist on
 * both the Purchase and Sale sides of a Purchase & Sale family but are distinct
 * obligations, so completing one side must never complete the other. (The
 * template-id match is inherently side-safe — Purchase and Sale templates have
 * different ids.)
 *
 * APS is intentionally excluded from the title fallback — it has dedicated
 * side-scoped completion logic in completeApsTask.ts.
 *
 * Returns peer task ids (excludes the source task itself).
 */
export async function findFamilySharedTaskPeers(params: {
  sourceTaskId: string;
  dealId: string;
  taskTemplateId: string | null;
  title: string | null;
  isApsTask: boolean;
}): Promise<string[]> {
  const { sourceTaskId, dealId, taskTemplateId, title, isApsTask } = params;

  const familyDealIds = await getFamilyDealIds(dealId);
  const otherDealIds = familyDealIds.filter((id) => id !== dealId);
  if (otherDealIds.length === 0) return [];

  const peerIds = new Set<string>();

  if (taskTemplateId) {
    const { data: byTemplate } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .in("deal_id", otherDealIds)
      .eq("task_template_id", taskTemplateId)
      .eq("is_shared", true);
    for (const t of byTemplate ?? []) {
      if (t.id !== sourceTaskId) peerIds.add(t.id);
    }
  }

  // Title-fallback: same-side mirror for non-APS shared tasks whose per-deal
  // template ids differ. Scoped to the source task's `side` so a Purchase-side
  // "Status of Mortgage" never completes the Sale-side row (and vice versa).
  const trimmedTitle = title?.trim();
  if (!isApsTask && trimmedTitle) {
    const { data: srcSideRow } = await supabaseAdmin
      .from("tasks")
      .select("side")
      .eq("id", sourceTaskId)
      .maybeSingle();
    const sourceSide = srcSideRow?.side ?? null;

    let titleQuery = supabaseAdmin
      .from("tasks")
      .select("id")
      .in("deal_id", otherDealIds)
      .ilike("title", trimmedTitle)
      .eq("is_shared", true);
    titleQuery = sourceSide === null ? titleQuery.is("side", null) : titleQuery.eq("side", sourceSide);

    const { data: byTitle } = await titleQuery;
    for (const t of byTitle ?? []) {
      if (t.id !== sourceTaskId) peerIds.add(t.id);
    }
  }

  return [...peerIds];
}
