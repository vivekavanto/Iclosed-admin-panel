import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";

/**
 * Resolves the set of `tasks.id`s that should be kept in lockstep with a given
 * shared task across the deal's co-purchaser / co-seller family.
 *
 * Why this exists: shared tasks are mirrored by `task_template_id`, but a
 * Purchase-side template and a Sale-side template have different ids. So for
 * Purchase & Sale deals the template-id match never crosses sides, and
 * co-sellers never receive sync updates for tasks like "Status of Mortgage",
 * "Upload Home Insurance Policy", or "Schedule an Appointment". Falling back
 * to a case-insensitive title match within the same family fixes this without
 * changing the data model.
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

  // Title-fallback: cross-side mirror for non-APS shared tasks. Matches the
  // Purchase-side "Status of Mortgage" against the Sale-side row with the
  // same name, even though their task_template_ids differ.
  const trimmedTitle = title?.trim();
  if (!isApsTask && trimmedTitle) {
    const { data: byTitle } = await supabaseAdmin
      .from("tasks")
      .select("id")
      .in("deal_id", otherDealIds)
      .ilike("title", trimmedTitle)
      .eq("is_shared", true);
    for (const t of byTitle ?? []) {
      if (t.id !== sourceTaskId) peerIds.add(t.id);
    }
  }

  return [...peerIds];
}
