/**
 * Server-side queries behind the admin half of "Deposit Funds Into Our Trust
 * Account".
 *
 * They live here rather than inside the route because two routes now need the
 * same answers — /deposit-task (statement, balance, activation) and
 * /deposit-task/proof (the client's proof of deposit, which an admin can upload
 * on the client's behalf) — and the two must never disagree about which task
 * row, which leads or which documents belong to the file.
 */

import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { getFamilyDealIds } from "./familyDeals";
import { resolvePrimaryDealId } from "./primaryDeal";
import { findFamilySharedTaskPeers } from "./findFamilySharedTaskPeers";
import {
  STATEMENT_OF_ACCOUNT_DOC_TYPE,
  PROOF_OF_DEPOSIT_DOC_TYPE,
  PROOF_OF_DEPOSIT_FIELD_LABEL,
  isTaskInactive,
} from "./depositTask";
import { DEPOSIT_TASK_LEAD_COLUMNS } from "./sendDepositTaskEmail";

export type DepositTaskRow = {
  id: string;
  deal_id: string;
  title: string | null;
  status: string | null;
  balance_due: number | null;
  activation_required: boolean | null;
  activated_at: string | null;
  task_template_id: string | null;
  milestone_id: string | null;
  completed_at: string | null;
};

export type DepositDoc = {
  id: string;
  lead_id?: string;
  file_name: string | null;
  file_url: string | null;
  created_at: string | null;
};

/**
 * One uploaded proof of deposit, as the panel shows it.
 *
 * Both ids are optional because the two stores can disagree: the client's
 * answer lives in `task_responses`, the bytes in `lead_corporate_docs`, and a
 * response row frequently carries only a file name (see sendDepositProofEmail).
 * Whichever exists is what can be removed.
 */
export type DepositProof = {
  response_id: string | null;
  doc_id: string | null;
  file_name: string | null;
  file_url: string | null;
  created_at: string | null;
};

/** Everyone on the file, primary first. */
export async function familyLeads(dealId: string) {
  const familyDealIds = await getFamilyDealIds(dealId);
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .in("id", familyDealIds)
    .eq("is_deleted", false);

  const leadIds = [
    ...new Set((deals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
  ];
  if (leadIds.length === 0) return [];

  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select(DEPOSIT_TASK_LEAD_COLUMNS)
    .in("id", leadIds)
    .eq("is_deleted", false)
    .order("parent_lead_id", { ascending: true, nullsFirst: true });

  return leads ?? [];
}

/** The lead every deposit document is filed against — the family's primary. */
export function primaryLeadIdOf(leads: Awaited<ReturnType<typeof familyLeads>>) {
  return leads.find((l) => !l.parent_lead_id)?.id ?? leads[0]?.id ?? null;
}

/**
 * The one deposit task for the family.
 *
 * It is a SHARED task, so it lives on the primary deal only — a co-purchaser's
 * deal never gets its own copy (see convertLead). Resolving through the primary
 * means the co-person's deal page shows and edits the same row, rather than
 * quietly reporting "no task" on half the family's pages.
 *
 * Matched by title rather than template id: `tasks.title` is a per-deal
 * snapshot, and a file seeded before the template existed can still be repaired
 * by renaming a task rather than needing a data migration.
 */
export async function loadDepositTask(dealId: string): Promise<DepositTaskRow | null> {
  const primaryDealId = await resolvePrimaryDealId(dealId);
  const { data } = await supabaseAdmin
    .from("tasks")
    .select(
      "id, deal_id, title, status, balance_due, activation_required, activated_at, task_template_id, milestone_id, completed_at",
    )
    .eq("deal_id", primaryDealId)
    .eq("is_deleted", false)
    .ilike("title", "%deposit funds into our trust account%")
    .maybeSingle();
  return (data as DepositTaskRow | null) ?? null;
}

/** The statement lives on the family's PRIMARY lead so everyone can see it. */
export async function loadStatement(leadIds: string[]): Promise<DepositDoc | null> {
  if (leadIds.length === 0) return null;
  const { data } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_name, file_url, created_at")
    .in("lead_id", leadIds)
    .eq("doc_type", STATEMENT_OF_ACCOUNT_DOC_TYPE)
    .order("created_at", { ascending: false })
    .limit(1);
  return data?.[0] ?? null;
}

/**
 * Every proof of deposit on the file, newest first.
 *
 * Read from both stores for the same reason the clerk email is: the task's own
 * file responses are authoritative (they are the answer to THIS task), but a
 * response row often records only a file name, so the family's
 * `proof_of_deposit` documents fill in the URL — and catch a document uploaded
 * before a response row existed.
 */
export async function loadProofs(
  taskId: string | null,
  leadIds: string[],
): Promise<DepositProof[]> {
  const byUrl = new Map<string, DepositProof>();
  const orphans: DepositProof[] = [];

  if (taskId) {
    const { data: responses } = await supabaseAdmin
      .from("task_responses")
      .select("id, file_name, file_url, field_type")
      .eq("task_id", taskId)
      .eq("field_type", "file");

    for (const r of responses ?? []) {
      const proof: DepositProof = {
        response_id: r.id,
        doc_id: null,
        file_name: r.file_name,
        file_url: r.file_url,
        created_at: null,
      };
      if (r.file_url) byUrl.set(r.file_url, proof);
      else if (r.file_name) orphans.push(proof);
    }
  }

  if (leadIds.length > 0) {
    const { data: docs } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("id, file_name, file_url, created_at")
      .in("lead_id", leadIds)
      .eq("doc_type", PROOF_OF_DEPOSIT_DOC_TYPE)
      .order("created_at", { ascending: false });

    for (const d of docs ?? []) {
      if (!d.file_url) continue;
      const existing = byUrl.get(d.file_url);
      if (existing) {
        // Same file, two stores: keep the response id (what the task answers
        // with) and take the document's id and date, which the response lacks.
        existing.doc_id = d.id;
        existing.created_at = d.created_at;
        existing.file_name = existing.file_name ?? d.file_name;
        continue;
      }
      byUrl.set(d.file_url, {
        response_id: null,
        doc_id: d.id,
        file_name: d.file_name,
        file_url: d.file_url,
        created_at: d.created_at,
      });
    }
  }

  return [...byUrl.values(), ...orphans].sort((a, b) =>
    (b.created_at ?? "").localeCompare(a.created_at ?? ""),
  );
}

/**
 * The form field the client's proof answers.
 *
 * Matched by label rather than position because a template can gain fields;
 * falls back to the template's only file field so a file seeded with a renamed
 * field still records an answer that maybeCompleteFileTask can match.
 */
export async function loadProofField(
  taskTemplateId: string | null,
): Promise<{ id: string; label: string } | null> {
  if (!taskTemplateId) return null;
  const { data } = await supabaseAdmin
    .from("task_form_fields")
    .select("id, label")
    .eq("task_template_id", taskTemplateId)
    .eq("field_type", "file");

  const fields = data ?? [];
  const byLabel = fields.find(
    (f) =>
      (f.label ?? "").trim().toLowerCase() ===
      PROOF_OF_DEPOSIT_FIELD_LABEL.toLowerCase(),
  );
  return byLabel ?? fields[0] ?? null;
}

/**
 * Legacy files can carry a copy of a shared task on a co-person's deal (rows
 * created before shared tasks were consolidated). Mirror writes to them so the
 * two never disagree about the balance or whether the task is live.
 */
export async function mirrorToPeers(
  task: Pick<DepositTaskRow, "id" | "deal_id" | "task_template_id" | "title">,
  patch: Record<string, unknown>,
) {
  const peers = await depositTaskPeers(task);
  if (peers.length === 0) return;
  try {
    await supabaseAdmin.from("tasks").update(patch).in("id", peers);
  } catch (err) {
    logger.warn("[DepositTask] peer mirror failed (non-blocking):", err);
  }
}

/** Shared-task copies of the deposit task elsewhere in the family, if any. */
export async function depositTaskPeers(
  task: Pick<DepositTaskRow, "id" | "deal_id" | "task_template_id" | "title">,
): Promise<string[]> {
  try {
    return await findFamilySharedTaskPeers({
      sourceTaskId: task.id,
      dealId: task.deal_id,
      taskTemplateId: task.task_template_id,
      title: task.title,
      isApsTask: false,
    });
  } catch (err) {
    logger.warn("[DepositTask] peer lookup failed (non-blocking):", err);
    return [];
  }
}

export function shape(
  task: DepositTaskRow | null,
  statement: DepositDoc | null,
  proofs: DepositProof[] = [],
) {
  return {
    task: task
      ? {
          id: task.id,
          deal_id: task.deal_id,
          title: task.title,
          status: task.status,
          balance_due: task.balance_due,
          activation_required: task.activation_required,
          activated_at: task.activated_at,
          completed_at: task.completed_at,
          // What the admin table shows in the Status column: a task waiting on
          // activation reads "Inactive" even though its status is Pending.
          is_inactive: isTaskInactive(task),
        }
      : null,
    statement,
    proofs,
  };
}
