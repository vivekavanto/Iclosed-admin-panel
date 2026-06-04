import supabaseAdmin from "./supabaseAdmin";

/**
 * Auto-populate a newly created deal's "Personal Information" task with the
 * PERSON-LEVEL answers (and identification documents) the same client already
 * provided on a PRIOR deal.
 *
 * Why this exists: once a customer fills Personal Information once, a returning
 * customer who gets a new deal shouldn't have to re-enter their identity. The
 * admin "Clone from previous" drawer already does this manually; this runs the
 * same idea AUTOMATICALLY at conversion — but limited to person-level fields.
 *
 * Design choices (mirrors clone-from-previous so the behaviour is consistent):
 *   - Source = the SAME client's most recent prior deal (by deals.client_id).
 *   - Personal Info tasks are matched across deals by task_template_id, so the
 *     copied responses carry the exact field_id / field_label / field_type the
 *     new deal's form expects (that is what makes them render pre-filled).
 *   - ONLY person-level field labels are copied (name / marital / citizenship /
 *     occupation / employer phone / phone / address). Deal-specific answers
 *     (source of funds, "is THIS property your primary residence", signing
 *     preference, etc.) are deliberately skipped — they don't carry across deals.
 *   - Identification tasks are NOT touched here; ID documents are copied via
 *     lead_corporate_docs (same as the manual clone), avoiding double-writes.
 *   - Idempotent: a field already answered on the new deal is never overwritten.
 *
 * Fully null/throw-safe by contract — callers wrap this in try/catch so it can
 * never block a conversion.
 */

const norm = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const isEmptyVal = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const isPersonalInfoTitle = (title: string | null | undefined) =>
  (title ?? "").toLowerCase().includes("personal info");

/**
 * Allowlist: only copy answers whose field label is a person-level attribute.
 * Default is SKIP, so anything not matched here (deal-specific questions) is
 * left for the customer to answer fresh on the new deal.
 */
function isPersonLevelLabel(label: string | null | undefined): boolean {
  const l = (label ?? "").toLowerCase().trim();
  if (!l) return false;
  // Defensive explicit exclusions for known deal-specific questions.
  if (l.includes("source of funds")) return false;
  if (l.includes("primary residence") || l.includes("investment property")) return false;
  if (l.includes("sign the document") || l.includes("in person or virtually")) return false;
  if (l.includes("ever owned a property")) return false;
  if (l.includes("outside of canada")) return false;
  return (
    l.includes("marital") ||
    l.includes("citizenship") ||
    l.includes("occupation") ||
    ((l.includes("employer") || l.includes("business")) && l.includes("phone")) ||
    l.includes("phone number") ||
    l.includes("street") ||
    l === "city" ||
    l.startsWith("city") ||
    l.includes("postal") ||
    l.includes("province") ||
    l.includes("unit") ||
    l.includes("date of birth") ||
    l === "dob" ||
    l.includes("first name") ||
    l.includes("last name") ||
    l.includes("full name")
  );
}

export async function prefillPersonalInfoFromPriorDeal(opts: {
  newDealId: string;
  newLeadId: string;
  clientId: string;
}): Promise<{ copiedResponses: number; copiedDocs: number; sourceDealId: string | null }> {
  const { newDealId, newLeadId, clientId } = opts;
  let copiedResponses = 0;
  let copiedDocs = 0;
  let sourceDealId: string | null = null;

  if (!newDealId || !clientId) return { copiedResponses, copiedDocs, sourceDealId };

  // 1. The new deal's Personal Info task(s).
  const { data: newTasks } = await supabaseAdmin
    .from("tasks")
    .select("id, task_template_id, title")
    .eq("deal_id", newDealId);
  const newPITasks = (newTasks ?? []).filter((t) => isPersonalInfoTitle(t.title));

  // 2. The SAME client's prior deals, most recent first.
  const { data: priorDeals } = await supabaseAdmin
    .from("deals")
    .select("id, lead_id, created_at")
    .eq("client_id", clientId)
    .neq("id", newDealId)
    .order("created_at", { ascending: false });

  if (!priorDeals || priorDeals.length === 0) {
    return { copiedResponses, copiedDocs, sourceDealId };
  }
  const dealRank = new Map(priorDeals.map((d, i) => [d.id, i]));
  const leadRank = new Map(priorDeals.map((d, i) => [d.lead_id, i]));
  const priorDealIds = priorDeals.map((d) => d.id);

  // ── Copy person-level Personal Info responses ─────────────────────────────
  if (newPITasks.length > 0) {
    const { data: priorTasks } = await supabaseAdmin
      .from("tasks")
      .select("id, task_template_id, title, deal_id")
      .in("deal_id", priorDealIds);
    // Prior Personal Info tasks, ordered most-recent deal first.
    const priorPITasks = (priorTasks ?? [])
      .filter((t) => isPersonalInfoTitle(t.title) && t.task_template_id)
      .sort((a, b) => (dealRank.get(a.deal_id) ?? 0) - (dealRank.get(b.deal_id) ?? 0));
    const taskToDeal = new Map(priorPITasks.map((t) => [t.id, t.deal_id]));

    // All prior PI task ids per template, most-recent first. We look at EVERY
    // prior deal (not just the latest) because the most recent one may be an
    // empty/unfilled task — we want the latest deal that actually has a value.
    const priorTaskIdsByTemplate = new Map<string, string[]>();
    for (const t of priorPITasks) {
      if (!priorTaskIdsByTemplate.has(t.task_template_id!)) {
        priorTaskIdsByTemplate.set(t.task_template_id!, []);
      }
      priorTaskIdsByTemplate.get(t.task_template_id!)!.push(t.id);
    }

    const allSrcTaskIds = [
      ...new Set(
        newPITasks.flatMap((nt) =>
          nt.task_template_id ? priorTaskIdsByTemplate.get(nt.task_template_id) ?? [] : [],
        ),
      ),
    ];

    if (allSrcTaskIds.length > 0) {
      const tgtTaskIds = newPITasks.map((t) => t.id);
      const [{ data: srcResp }, { data: tgtResp }] = await Promise.all([
        supabaseAdmin
          .from("task_responses")
          .select("task_id, field_id, field_label, field_type, value, file_url, file_name")
          .in("task_id", allSrcTaskIds),
        supabaseAdmin
          .from("task_responses")
          .select("task_id, field_id, field_label")
          .in("task_id", tgtTaskIds),
      ]);

      const occupied = new Set<string>();
      for (const r of tgtResp ?? []) {
        occupied.add(`${r.task_id}::${r.field_id ?? r.field_label ?? ""}`);
      }
      const srcByTask = new Map<string, any[]>();
      for (const r of srcResp ?? []) {
        if (!srcByTask.has(r.task_id)) srcByTask.set(r.task_id, []);
        srcByTask.get(r.task_id)!.push(r);
      }

      const toInsert: Array<Record<string, unknown>> = [];
      for (const nt of newPITasks) {
        if (!nt.task_template_id) continue;
        const srcTaskIds = priorTaskIdsByTemplate.get(nt.task_template_id) ?? []; // recent first

        // For each form field, take the value from the most recent prior deal
        // that actually has a non-empty, person-level answer.
        const chosenByField = new Map<string, any>();
        for (const sid of srcTaskIds) {
          for (const r of srcByTask.get(sid) ?? []) {
            if (!isPersonLevelLabel(r.field_label)) continue;
            if (isEmptyVal(r.value)) continue;
            const fk = r.field_id ?? r.field_label ?? "";
            if (!chosenByField.has(fk)) chosenByField.set(fk, r); // first seen = most recent
          }
        }

        for (const [fk, r] of chosenByField) {
          const key = `${nt.id}::${fk}`;
          if (occupied.has(key)) continue;
          occupied.add(key);
          if (sourceDealId === null) sourceDealId = taskToDeal.get(r.task_id) ?? null;
          toInsert.push({
            task_id: nt.id,
            field_id: r.field_id,
            field_label: r.field_label,
            field_type: r.field_type,
            value: r.value,
            file_url: r.file_url,
            file_name: r.file_name,
          });
        }
      }

      if (toInsert.length > 0) {
        const { error } = await supabaseAdmin.from("task_responses").insert(toInsert);
        if (!error) copiedResponses = toInsert.length;
      }
    }
  }

  // ── Copy identification documents from the prior lead(s) ──────────────────
  const priorLeadIds = [...new Set(priorDeals.map((d) => d.lead_id).filter(Boolean))] as string[];
  if (newLeadId && priorLeadIds.length > 0) {
    const [{ data: srcDocs }, { data: tgtDocs }] = await Promise.all([
      supabaseAdmin
        .from("lead_corporate_docs")
        .select("file_name, file_url, doc_type, custom_type, lead_id")
        .in("lead_id", priorLeadIds)
        .eq("doc_type", "identification"),
      supabaseAdmin
        .from("lead_corporate_docs")
        .select("custom_type")
        .eq("lead_id", newLeadId)
        .eq("doc_type", "identification"),
    ]);

    const occupied = new Set(
      (tgtDocs ?? []).map((r) => norm(r.custom_type).toLowerCase()).filter(Boolean),
    );
    const seen = new Set<string>();
    const sortedDocs = (srcDocs ?? [])
      .slice()
      .sort((a, b) => (leadRank.get(a.lead_id) ?? 0) - (leadRank.get(b.lead_id) ?? 0));

    const docsToInsert = [] as Array<Record<string, unknown>>;
    for (const d of sortedDocs) {
      const ct = norm(d.custom_type).toLowerCase();
      if (ct && (occupied.has(ct) || seen.has(ct))) continue;
      if (ct) seen.add(ct);
      docsToInsert.push({
        lead_id: newLeadId,
        file_name: d.file_name,
        file_url: d.file_url,
        doc_type: d.doc_type,
        custom_type: d.custom_type,
      });
    }
    if (docsToInsert.length > 0) {
      const { error } = await supabaseAdmin.from("lead_corporate_docs").insert(docsToInsert);
      if (!error) copiedDocs = docsToInsert.length;
    }
  }

  return { copiedResponses, copiedDocs, sourceDealId };
}
