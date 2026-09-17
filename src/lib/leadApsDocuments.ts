// Every agreement on a lead's file, wherever it happens to live.
//
// ── Why this is not a single table read ─────────────────────────────────────
// The APS legitimately lands in one of TWO stores, and which one depends on how
// it arrived:
//
//   • Uploaded on the intake form  → a `lead_corporate_docs` row (doc_type
//     "aps_purchase" / "aps_sale" / "aps", or a legacy "document" row whose
//     custom_type names the APS).
//   • Answered on the APS task in the client portal → `task_responses` ONLY.
//     Nothing copies it back to lead_corporate_docs; completeApsTask.ts bridges
//     the other direction (lead_corporate_docs → task_responses) and only for
//     files it has run over.
//
// Reading `lead_corporate_docs` alone is what made an existing customer's
// agreement invisible on the lead page while the deal page showed it against
// the APS task. That store is also the only one that exists before conversion,
// when there is no deal and therefore no task to answer.
//
// The matching, side resolution and de-duplication are NOT re-implemented here:
// `loadApsMaterial` in dealPackage.ts already does all of it (four live doc_type
// shapes, side taken from the task template's lead_type because neither the task
// title nor the field label distinguishes the sides of a P&S file, dedupe by
// blob URL, purchase-side first). This module is the lead-scoped entry point to
// it — it works out which leads and deals make up the family and hands them
// over.

import supabaseAdmin from "./supabaseAdmin";
import { loadApsMaterial, type ApsDoc } from "./dealPackage";
import { logger } from "./logger";

/** Same test dealPackage.ts uses: "Agreement of Purchase and Sale…", or "APS". */
function isApsTaskTitle(title: string | null | undefined): boolean {
  const t = String(title ?? "").toLowerCase();
  return t.includes("agreement of purchase and sale") || /\baps\b/.test(t);
}

export interface LeadApsDocument {
  /** Whose upload it was. "" when the row belongs to a deal with no lead. */
  leadId: string;
  fileUrl: string;
  fileName: string;
  /** "Purchase" / "Sale" / the field's own label. "" when not side-specific. */
  label: string;
}

/**
 * The family a lead belongs to: the root lead, its co-clients, and every deal
 * hanging off them.
 *
 * Resolved from the ROOT lead (`parent_lead_id ?? id`) because intake files the
 * whole package against the primary, so a co-client's own row has none of it.
 * Deals may legitimately be absent — an unconverted lead has no deal yet, and
 * that is the case this page mainly serves.
 */
async function resolveFamily(
  leadId: string,
): Promise<{ leadIds: string[]; dealIds: string[] }> {
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .eq("id", leadId)
    .eq("is_deleted", false)
    .maybeSingle();

  if (leadErr || !lead) return { leadIds: [], dealIds: [] };

  const rootLeadId = lead.parent_lead_id ?? lead.id;

  const { data: familyLeads } = await supabaseAdmin
    .from("leads")
    .select("id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
    .eq("is_deleted", false);

  // Never narrow to nothing on an empty read — the lead itself still counts.
  const leadIds = [
    ...new Set([...(familyLeads ?? []).map((l) => l.id as string), lead.id as string]),
  ];

  const { data: familyDeals } = await supabaseAdmin
    .from("deals")
    .select("id")
    .in("lead_id", leadIds)
    .eq("is_deleted", false);

  return { leadIds, dealIds: (familyDeals ?? []).map((d) => d.id as string) };
}

/**
 * Files attached to an APS task whose response row carries a NAME but no URL.
 *
 * `loadApsMaterial` drops these (`if (!r.file_url) continue`), and for a client
 * who answered the agreement task in the portal that can be the only record of
 * the file — which is exactly how an existing customer's agreement ended up
 * visible on the deal page and missing here. The deal page does not hit this
 * because /api/admin/task-responses performs the same resolution before it
 * returns; this is that step, for this one page.
 *
 * Resolution is by `file_name` against `lead_corporate_docs` for the family,
 * which is the only join available — these rows have nothing else to match on.
 * Two family members with an identically-named file therefore resolve to the
 * same blob; that is the existing behaviour of the task-responses route, and it
 * is preferable to showing neither.
 *
 * Deliberately NOT pushed into `loadApsMaterial`: that function also builds the
 * clerk email and the deal package PDF, and widening what those attach is not
 * this change's business.
 */
async function loadUnresolvedApsTaskFiles(
  leadIds: string[],
  dealIds: string[],
): Promise<LeadApsDocument[]> {
  if (dealIds.length === 0 || leadIds.length === 0) return [];

  const { data: tasks } = await supabaseAdmin
    .from("tasks")
    .select("id, title, deal_id")
    .in("deal_id", dealIds)
    .eq("is_deleted", false);

  const apsTasks = (tasks ?? []).filter((t) => isApsTaskTitle(t.title as string));
  if (apsTasks.length === 0) return [];

  const { data: responses } = await supabaseAdmin
    .from("task_responses")
    .select("task_id, file_name, file_url, field_type")
    .in(
      "task_id",
      apsTasks.map((t) => t.id as string),
    )
    .eq("field_type", "file");

  const unresolved = (responses ?? []).filter(
    (r) => !r.file_url && Boolean(r.file_name),
  );
  if (unresolved.length === 0) return [];

  const { data: docs } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("lead_id, file_name, file_url")
    .in("lead_id", leadIds);

  const byName = new Map<string, { leadId: string; fileUrl: string }>();
  for (const d of docs ?? []) {
    const name = (d.file_name as string) ?? "";
    const url = (d.file_url as string) ?? "";
    if (!name || !url || byName.has(name)) continue;
    byName.set(name, { leadId: (d.lead_id as string) ?? "", fileUrl: url });
  }

  const out: LeadApsDocument[] = [];
  for (const r of unresolved) {
    const match = byName.get((r.file_name as string) ?? "");
    if (!match) continue;
    out.push({
      leadId: match.leadId,
      fileUrl: match.fileUrl,
      fileName: (r.file_name as string) ?? "Agreement of Purchase and Sale",
      label: "",
    });
  }
  return out;
}

/**
 * Every agreement on this lead's file, from both stores, deduped and ordered
 * purchase-side first.
 *
 * `leadId` must already be validated as a UUID — it reaches a PostgREST `.or()`
 * filter that interpolates it into a string rather than binding it.
 *
 * Returns [] rather than throwing: a lead page that renders without its
 * agreement is recoverable, one that 500s is not.
 */
export async function loadLeadApsDocuments(
  leadId: string,
): Promise<LeadApsDocument[]> {
  try {
    const { leadIds, dealIds } = await resolveFamily(leadId);
    if (leadIds.length === 0) return [];

    const [{ docs }, recovered] = await Promise.all([
      loadApsMaterial(leadIds, dealIds),
      loadUnresolvedApsTaskFiles(leadIds, dealIds),
    ]);

    const out: LeadApsDocument[] = docs.map((d: ApsDoc) => ({
      leadId: d.leadId,
      fileUrl: d.fileUrl,
      fileName: d.fileName,
      // loadApsMaterial captions a task-sourced file "Agreement" when the
      // template carries no side. That is a caption for a PDF cover page, not a
      // side badge, so it is dropped here and the UI simply shows no badge.
      label: d.label === "Agreement" ? "" : d.label,
    }));

    // Append whatever the URL-less response rows resolved to, keeping the
    // purchase-first order loadApsMaterial established for the rest.
    const seen = new Set(out.map((d) => d.fileUrl));
    for (const d of recovered) {
      if (seen.has(d.fileUrl)) continue;
      seen.add(d.fileUrl);
      out.push(d);
    }

    return out;
  } catch (err) {
    logger.error("[LeadApsDocuments] could not load agreements:", err);
    return [];
  }
}
