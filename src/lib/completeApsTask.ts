import supabaseAdmin from "./supabaseAdmin";
import { getFamilyDealIds } from "./familyDeals";
import { recalcMilestonesForFamily } from "./recalcMilestones";

/**
 * Marks the APS shared task as "Completed" for a deal and all linked
 * co-purchaser deals, then recalculates milestone statuses.
 *
 * Identification: uses `task_templates.is_aps_task = true` to find the
 * correct template, then matches tasks by `task_template_id`.
 *
 * This is idempotent — calling it when the task is already completed is a
 * no-op that returns `{ success: true, already_completed: true }`.
 *
 * @param dealId – any deal in the family (primary or co-purchaser)
 */
export async function completeApsTask(dealId: string): Promise<{
  success: boolean;
  already_completed?: boolean;
  error?: string;
}> {
  try {
    // ── 1. Resolve the primary deal ──────────────────────────────────────────
    let primaryDealId = dealId;

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
        if (rootDeal?.id) primaryDealId = rootDeal.id;
      }
    }

    // ── 2. Find the APS task template ────────────────────────────────────────
    const { data: apsTemplates } = await supabaseAdmin
      .from("task_templates")
      .select("id")
      .eq("is_aps_task", true)
      .eq("is_deleted", false);

    if (!apsTemplates || apsTemplates.length === 0) {
      return { success: false, error: "No APS task template found" };
    }

    const apsTemplateIds = apsTemplates.map((t) => t.id);

    // ── 3. Find the APS shared task on the primary deal ──────────────────────
    const { data: apsTask } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id, status")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .in("task_template_id", apsTemplateIds)
      .maybeSingle();

    if (!apsTask) {
      return { success: false, error: "APS task not found on primary deal" };
    }

    // Idempotent — already done
    if (apsTask.status === "Completed") {
      return { success: true, already_completed: true };
    }

    const now = new Date().toISOString();
    const completionPayload = {
      status: "Completed" as const,
      completed: true,
      completed_at: now,
    };

    // ── 4. Complete the task on the primary deal ─────────────────────────────
    await supabaseAdmin
      .from("tasks")
      .update(completionPayload)
      .eq("id", apsTask.id);

    // ── 4b. Bridge APS documents from lead_corporate_docs → task_responses ──
    // Intake uploads go to lead_corporate_docs (no task_id). The Doc column
    // and View Documents fetch from task_responses (needs task_id). Bridge
    // them so Intake-uploaded APS docs appear in the deal detail views.
    try {
      const familyDealIdsForDocs = await getFamilyDealIds(primaryDealId);

      // Collect all family lead IDs
      const { data: familyDeals } = await supabaseAdmin
        .from("deals")
        .select("lead_id")
        .in("id", familyDealIdsForDocs);

      const familyLeadIds = [...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean))];

      if (familyLeadIds.length > 0) {
        // Find APS documents in lead_corporate_docs (doc_type: "document", "aps", or custom_type: "APS Document")
        const { data: apsDocs } = await supabaseAdmin
          .from("lead_corporate_docs")
          .select("file_name, file_url")
          .in("lead_id", familyLeadIds)
          .or('doc_type.eq.document,doc_type.eq.aps,custom_type.ilike.%APS%');

        if (apsDocs && apsDocs.length > 0) {
          // Check which files already exist as task_responses to avoid duplicates
          const { data: existingResponses } = await supabaseAdmin
            .from("task_responses")
            .select("file_name")
            .eq("task_id", apsTask.id)
            .eq("field_type", "file");

          const existingFileNames = new Set((existingResponses ?? []).map((r) => r.file_name));

          const newResponses = apsDocs
            .filter((doc) => doc.file_name && !existingFileNames.has(doc.file_name))
            .map((doc) => ({
              task_id: apsTask.id,
              field_type: "file",
              field_label: "Upload Agreement of Purchase and Sale",
              file_name: doc.file_name,
              file_url: doc.file_url,
            }));

          if (newResponses.length > 0) {
            await supabaseAdmin.from("task_responses").insert(newResponses);
          }
        }
      }
    } catch {
      // Non-blocking — document bridging failure should not break task completion
    }

    // ── 5. Sync to all co-purchaser deals ────────────────────────────────────
    const familyDealIds = await getFamilyDealIds(primaryDealId);
    const otherDealIds = familyDealIds.filter((id) => id !== primaryDealId);

    if (otherDealIds.length > 0) {
      await supabaseAdmin
        .from("tasks")
        .update(completionPayload)
        .eq("task_template_id", apsTask.task_template_id)
        .eq("is_shared", true)
        .in("deal_id", otherDealIds);
    }

    // ── 6. Recalculate milestones for all family deals ───────────────────────
    await recalcMilestonesForFamily(familyDealIds, primaryDealId);

    return { success: true };
  } catch (err: any) {
    console.error("[completeApsTask] Error:", err);
    return { success: false, error: err.message ?? "Unknown error" };
  }
}
