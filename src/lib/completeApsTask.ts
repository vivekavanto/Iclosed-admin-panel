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
 * For combined Purchase & Sale deals, only completes the APS task(s) whose
 * template `lead_type` matches the side(s) that were actually uploaded.
 * If no side is supplied, the function inspects `lead_corporate_docs` to
 * auto-detect which side(s) had an upload (via `doc_type` of `aps_purchase`
 * or `aps_sale`).
 *
 * This is idempotent — calling it when the relevant tasks are already
 * completed is a no-op.
 *
 * @param dealId – any deal in the family (primary or co-purchaser)
 * @param opts.forLeadTypes – optional explicit list of lead_types to
 *   complete (e.g. ["Purchase"], ["Sale"], ["Purchase","Sale"]).
 */
export async function completeApsTask(
  dealId: string,
  opts: { forLeadTypes?: string[] } = {},
): Promise<{
  success: boolean;
  already_completed?: boolean;
  error?: string;
  completed_lead_types?: string[];
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

    // ── 2. Find the APS task templates (with their lead_type) ────────────────
    const { data: apsTemplates } = await supabaseAdmin
      .from("task_templates")
      .select("id, lead_type")
      .eq("is_aps_task", true)
      .eq("is_deleted", false);

    if (!apsTemplates || apsTemplates.length === 0) {
      return { success: false, error: "No APS task template found" };
    }

    const apsTemplateLeadTypeMap = new Map<string, string>(
      (apsTemplates as any[]).map((t) => [t.id, (t.lead_type ?? "").toLowerCase().trim()]),
    );
    const apsTemplateIds = apsTemplates.map((t) => t.id);

    // ── 2b. Determine which lead_type(s) to mark complete ────────────────────
    // Priority: explicit opts → auto-detect from lead_corporate_docs → all.
    let allowLeadTypes: Set<string> | null = null;
    if (opts.forLeadTypes && opts.forLeadTypes.length > 0) {
      allowLeadTypes = new Set(
        opts.forLeadTypes.map((s) => s.toLowerCase().trim()).filter(Boolean),
      );
    } else {
      // Auto-detect from uploaded docs across the entire family
      const familyDealIdsForDetect = await getFamilyDealIds(primaryDealId);
      const { data: familyDealsForDetect } = await supabaseAdmin
        .from("deals")
        .select("lead_id")
        .in("id", familyDealIdsForDetect);
      const familyLeadIdsForDetect = [
        ...new Set((familyDealsForDetect ?? []).map((d) => d.lead_id).filter(Boolean)),
      ];
      if (familyLeadIdsForDetect.length > 0) {
        const { data: docs } = await supabaseAdmin
          .from("lead_corporate_docs")
          .select("doc_type")
          .in("lead_id", familyLeadIdsForDetect);
        const detected = new Set<string>();
        for (const d of docs ?? []) {
          const t = (d.doc_type ?? "").toLowerCase().trim();
          if (t === "aps_purchase") detected.add("purchase");
          else if (t === "aps_sale") detected.add("sale");
        }
        if (detected.size > 0) {
          allowLeadTypes = detected;
        }
        // If only generic "aps"/"document" rows exist (no side specified),
        // leave allowLeadTypes null → behave as before (complete all sides).
      }
    }

    // ── 3. Find the APS shared task(s) on the primary deal ───────────────────
    // A combined deal (e.g. Purchase & Sale) can have one APS task per lead type,
    // so collect all of them rather than expecting a single row.
    const { data: apsTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id, status")
      .eq("deal_id", primaryDealId)
      .eq("is_shared", true)
      .in("task_template_id", apsTemplateIds);

    if (!apsTasks || apsTasks.length === 0) {
      return { success: false, error: "APS task not found on primary deal" };
    }

    // Filter APS tasks by allowed lead_types (if any constraint)
    const matchesAllow = (task: { task_template_id: string | null }) => {
      if (!allowLeadTypes) return true;
      const lt = task.task_template_id
        ? apsTemplateLeadTypeMap.get(task.task_template_id) ?? ""
        : "";
      return allowLeadTypes.has(lt);
    };

    const pendingApsTasks = apsTasks
      .filter((t) => matchesAllow(t))
      .filter((t) => t.status !== "Completed");

    const allowedApsTasks = apsTasks.filter((t) => matchesAllow(t));
    const alreadyComplete = pendingApsTasks.length === 0;

    const now = new Date().toISOString();
    const completionPayload = {
      status: "Completed" as const,
      completed: true,
      completed_at: now,
    };

    // ── 4. Complete each pending APS task on the primary deal ────────────────
    if (pendingApsTasks.length > 0) {
      await supabaseAdmin
        .from("tasks")
        .update(completionPayload)
        .in("id", pendingApsTasks.map((t) => t.id));
    }

    // ── 4b. Bridge APS documents from lead_corporate_docs → task_responses ──
    // Intake uploads go to lead_corporate_docs (no task_id). The Doc column
    // and View Documents fetch from task_responses (needs task_id). Bridge
    // them so Intake-uploaded APS docs appear in the deal detail views.
    //
    // Matching:  doc.doc_type   APS task lead_type that gets the doc
    //            -------------  ---------------------------------------
    //            aps_purchase   Purchase
    //            aps_sale       Sale
    //            aps            both Purchase and Sale (legacy / generic)
    //            document w/    both (legacy fallback when custom_type
    //              custom_type   indicates APS)
    //              ~ APS
    try {
      const familyDealIdsForDocs = await getFamilyDealIds(primaryDealId);

      const { data: familyDeals } = await supabaseAdmin
        .from("deals")
        .select("lead_id")
        .in("id", familyDealIdsForDocs);

      const familyLeadIds = [...new Set((familyDeals ?? []).map((d) => d.lead_id).filter(Boolean))];

      if (familyLeadIds.length > 0) {
        // Pull every potentially-APS upload across the family. We include
        // aps_purchase / aps_sale / aps explicitly, plus the legacy
        // (doc_type='document' AND custom_type ilike '%APS%') case.
        const { data: apsDocs } = await supabaseAdmin
          .from("lead_corporate_docs")
          .select("file_name, file_url, doc_type, custom_type")
          .in("lead_id", familyLeadIds)
          .or(
            "doc_type.eq.aps_purchase,doc_type.eq.aps_sale,doc_type.eq.aps,doc_type.eq.document,custom_type.ilike.%APS%",
          );

        // Decide which lead_types each doc applies to.
        const docTargetsLeadType = (doc: { doc_type: string | null; custom_type: string | null }): Set<string> => {
          const dt = (doc.doc_type ?? "").toLowerCase();
          if (dt === "aps_purchase") return new Set(["purchase"]);
          if (dt === "aps_sale") return new Set(["sale"]);
          // Generic aps or document/custom_type APS — applies to all sides
          if (dt === "aps") return new Set(["purchase", "sale"]);
          // doc_type=document with custom_type ~ APS — legacy fallback
          if (dt === "document" && /aps/i.test(doc.custom_type ?? "")) {
            return new Set(["purchase", "sale"]);
          }
          return new Set();
        };

        if (apsDocs && apsDocs.length > 0) {
          // Bridge into ALL APS tasks (not just pending), so re-uploads after
          // completion still attach to the right task.
          for (const apsTaskRow of apsTasks ?? []) {
            const taskLeadType = apsTemplateLeadTypeMap.get(apsTaskRow.task_template_id ?? "") ?? "";
            if (!taskLeadType) continue;

            // Prefer this side's own doc. A side-specific upload
            // (aps_purchase / aps_sale) wins over a generic "aps" doc, so a
            // combined Purchase & Sale deal doesn't show the generic doc on
            // BOTH sides alongside the side-specific one (which is what made
            // a co-purchaser/co-seller see two APS documents). Only when a
            // side has no specific doc do we fall back to the generic/legacy
            // docs.
            const sideSpecificDocs = apsDocs.filter((doc) => {
              const dt = (doc.doc_type ?? "").toLowerCase();
              return (
                (taskLeadType === "purchase" && dt === "aps_purchase") ||
                (taskLeadType === "sale" && dt === "aps_sale")
              );
            });
            const matchingDocs = sideSpecificDocs.length > 0
              ? sideSpecificDocs
              : apsDocs.filter((doc) => docTargetsLeadType(doc).has(taskLeadType));
            if (matchingDocs.length === 0) continue;

            const desiredKeys = new Set(
              matchingDocs
                .filter((doc) => doc.file_name)
                .map((doc) => `${doc.file_name}|${doc.file_url ?? ""}`),
            );

            const { data: existingResponses } = await supabaseAdmin
              .from("task_responses")
              .select("id, file_name, file_url")
              .eq("task_id", apsTaskRow.id)
              .eq("field_type", "file");

            // Reconcile: drop any file response on this side's task that is no
            // longer one of the chosen docs (e.g. a stale generic doc now
            // superseded by a side-specific upload) so the Doc count reflects
            // exactly this side's APS. This also self-heals decks created by
            // the previous both-sides bridging.
            const staleIds = (existingResponses ?? [])
              .filter((r) => !desiredKeys.has(`${r.file_name ?? ""}|${r.file_url ?? ""}`))
              .map((r) => r.id);
            if (staleIds.length > 0) {
              await supabaseAdmin.from("task_responses").delete().in("id", staleIds);
            }

            const existingKeys = new Set(
              (existingResponses ?? [])
                .filter((r) => desiredKeys.has(`${r.file_name ?? ""}|${r.file_url ?? ""}`))
                .map((r) => `${r.file_name ?? ""}|${r.file_url ?? ""}`),
            );

            const newResponses = matchingDocs
              .filter((doc) => doc.file_name && !existingKeys.has(`${doc.file_name}|${doc.file_url ?? ""}`))
              .map((doc) => ({
                task_id: apsTaskRow.id,
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
      }
    } catch (err) {
      // Non-blocking — document bridging failure should not break task completion
      console.error("[completeApsTask] bridge failed (non-blocking):", err);
    }

    // ── 5. Sync to all co-purchaser deals ────────────────────────────────────
    const familyDealIds = await getFamilyDealIds(primaryDealId);
    const otherDealIds = familyDealIds.filter((id) => id !== primaryDealId);

    if (otherDealIds.length > 0) {
      const apsTaskTemplateIds = pendingApsTasks
        .map((t) => t.task_template_id)
        .filter((id): id is string => !!id);
      if (apsTaskTemplateIds.length > 0) {
        await supabaseAdmin
          .from("tasks")
          .update(completionPayload)
          .in("task_template_id", apsTaskTemplateIds)
          .eq("is_shared", true)
          .in("deal_id", otherDealIds);
      }
    }

    // ── 6. Recalculate milestones for all family deals ───────────────────────
    await recalcMilestonesForFamily(familyDealIds, primaryDealId);

    const completedLeadTypes = [
      ...new Set(
        pendingApsTasks
          .map((t) => apsTemplateLeadTypeMap.get(t.task_template_id ?? "") ?? "")
          .filter(Boolean),
      ),
    ];
    return {
      success: true,
      already_completed: alreadyComplete,
      completed_lead_types: completedLeadTypes,
    };
  } catch (err: any) {
    console.error("[completeApsTask] Error:", err);
    return { success: false, error: err.message ?? "Unknown error" };
  }
}
