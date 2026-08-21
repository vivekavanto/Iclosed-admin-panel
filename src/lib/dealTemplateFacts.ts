// File-level placeholder values for MANUALLY sent email templates.
//
// Every sender resolves its own vocabulary. The automatic senders know a lot
// about the file — notifyAllTasksComplete resolves {{ transaction }},
// {{ closing_date }}, {{ party_summary }}, {{ task_count }}…; sendWelcomeEmail,
// which is what Leads → "Send Email" ends up calling, only knew the recipient's
// own name, address and file number. So an admin who picked the "All Tasks
// Completed" or "Client Documents to Clerk" row from that picker got an email
// with raw "{{ transaction }}" text in it: renderTemplateSafe leaves a token it
// can't resolve exactly as written, by design.
//
// This module collects the file-level facts once so the manual path speaks the
// same vocabulary as the automatic ones. It is deliberately best-effort: any
// lookup that fails degrades that value to "" / "0" / "TBD" rather than failing
// the send, and a lead with no deal yet still gets every key (so no placeholder
// leaks through as literal braces).
//
// NOTE on the counts: a manual send attaches nothing, so `attached_count` and
// `linked_count` are 0 here — truthfully. Only "Email to Clerk" on the deal page
// and the automatic all-tasks alert attach the document package.

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

/** Placeholder name → resolved value. Every key is always present. */
export type DealFactValues = Record<string, string>;

/** Absolute link into the admin portal, matching the automatic senders. */
function adminBaseUrl(): string {
  const explicit = process.env.ADMIN_PORTAL_URL || process.env.NEXT_PUBLIC_ADMIN_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

/**
 * `deals.closing_date` is a DATE — format its Y/M/D parts in UTC so it doesn't
 * render as the previous day in a negative-offset timezone. Same helper the
 * other senders carry.
 */
function formatClosingDate(raw: string | null | undefined): string {
  if (!raw) return "TBD";
  const m = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(raw);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function fullName(row: { first_name?: string | null; last_name?: string | null }): string {
  return `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();
}

function joinNames(names: string[]): string {
  const clean = names.filter(Boolean);
  if (clean.length === 0) return "";
  if (clean.length === 1) return clean[0];
  return `${clean.slice(0, -1).join(", ")} and ${clean[clean.length - 1]}`;
}

/** Every key this module resolves, with the "nothing known yet" values. */
function emptyFacts(): DealFactValues {
  return {
    client_name: "",
    client_names: "",
    party_summary: "",
    co_party_names: "",
    closing_date: "TBD",
    deal_url: "",
    task_count: "0",
    document_count: "0",
    attached_count: "0",
    linked_count: "0",
  };
}

/**
 * File-level facts for the family this lead belongs to.
 *
 * @param lead the recipient's lead row (needs at least id, parent_lead_id)
 */
export async function loadDealTemplateFacts(lead: {
  id?: string | null;
  parent_lead_id?: string | null;
} | null | undefined): Promise<DealFactValues> {
  const facts = emptyFacts();
  const rootLeadId = lead?.parent_lead_id ?? lead?.id ?? null;
  if (!rootLeadId) return facts;

  try {
    // The family: root lead first, then co-purchasers / co-sellers.
    const { data: familyLeads } = await supabaseAdmin
      .from("leads")
      .select("id, first_name, last_name, parent_lead_id")
      .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`)
      .eq("is_deleted", false);

    const rows = familyLeads ?? [];
    const primary = rows.find((l) => l.id === rootLeadId) ?? null;
    const clientName = primary ? fullName(primary) : "";
    const coPartyNames = rows
      .filter((l) => l.id !== rootLeadId)
      .map(fullName)
      .filter(Boolean);

    facts.client_name = clientName;
    facts.co_party_names = coPartyNames.join(", ");
    facts.client_names = joinNames([clientName, ...coPartyNames]);
    facts.party_summary = facts.client_names;

    const familyLeadIds = rows.map((l) => l.id as string);
    if (familyLeadIds.length === 0) return facts;

    const { data: deals } = await supabaseAdmin
      .from("deals")
      .select("id, lead_id, closing_date")
      .in("lead_id", familyLeadIds);

    const dealRows = deals ?? [];
    const primaryDeal = dealRows.find((d) => d.lead_id === rootLeadId) ?? dealRows[0] ?? null;
    if (!primaryDeal) return facts;

    facts.closing_date = formatClosingDate(primaryDeal.closing_date);
    facts.deal_url = `${adminBaseUrl()}/admin/deals/${primaryDeal.id}`;

    const familyDealIds = dealRows.map((d) => d.id as string);

    // Tasks: shared tasks are a single source of truth on the primary deal,
    // personal ones exist per person — the same pooling notifyAllTasksComplete
    // does, so "N tasks completed" means the same thing in both emails.
    const [{ data: sharedTasks }, { data: personalTasks }, docCount] = await Promise.all([
      supabaseAdmin
        .from("tasks")
        .select("status")
        .eq("deal_id", primaryDeal.id)
        .eq("is_shared", true)
        .eq("is_deleted", false),
      supabaseAdmin
        .from("tasks")
        .select("status")
        .in("deal_id", familyDealIds)
        .or("is_shared.is.null,is_shared.eq.false")
        .eq("is_deleted", false),
      countFamilyDocuments(familyDealIds, familyLeadIds),
    ]);

    const pooled = [...(sharedTasks ?? []), ...(personalTasks ?? [])];
    facts.task_count = String(pooled.filter((t) => t.status === "Completed").length);
    facts.document_count = String(docCount);
  } catch (err) {
    // Best-effort: a half-filled fact set still beats failing the send.
    logger.warn("[dealTemplateFacts] lookup failed — using what resolved:", err);
  }

  return facts;
}

/**
 * How many documents the family has uploaded, across the three tables they can
 * land in. Counted head-only — the rows themselves are never needed here.
 */
async function countFamilyDocuments(
  familyDealIds: string[],
  familyLeadIds: string[],
): Promise<number> {
  try {
    const { data: tasks } = familyDealIds.length
      ? await supabaseAdmin
          .from("tasks")
          .select("id")
          .in("deal_id", familyDealIds)
          .eq("is_deleted", false)
      : { data: [] };
    const taskIds = (tasks ?? []).map((t) => t.id as string);

    const [responses, corporate, identification] = await Promise.all([
      taskIds.length
        ? supabaseAdmin
            .from("task_responses")
            .select("id", { count: "exact", head: true })
            .in("task_id", taskIds)
            .eq("field_type", "file")
        : Promise.resolve({ count: 0 }),
      familyLeadIds.length
        ? supabaseAdmin
            .from("lead_corporate_docs")
            .select("id", { count: "exact", head: true })
            .in("lead_id", familyLeadIds)
        : Promise.resolve({ count: 0 }),
      familyLeadIds.length
        ? supabaseAdmin
            .from("lead_identification_docs")
            .select("id", { count: "exact", head: true })
            .in("lead_id", familyLeadIds)
        : Promise.resolve({ count: 0 }),
    ]);

    return (responses.count ?? 0) + (corporate.count ?? 0) + (identification.count ?? 0);
  } catch (err) {
    logger.warn("[dealTemplateFacts] document count failed:", err);
    return 0;
  }
}
