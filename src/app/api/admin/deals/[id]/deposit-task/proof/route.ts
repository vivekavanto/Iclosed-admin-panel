import { NextResponse, after } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { recalcMilestonesForFamily } from "@/lib/recalcMilestones";
import { maybeCompleteFileTask } from "@/lib/maybeCompleteFileTask";
import { sendDepositProofEmail } from "@/lib/sendDepositProofEmail";
import {
  PROOF_OF_DEPOSIT_DOC_TYPE,
  PROOF_OF_DEPOSIT_FIELD_LABEL,
} from "@/lib/depositTask";
import {
  depositTaskPeers,
  familyLeads,
  loadDepositTask,
  loadProofField,
  loadProofs,
  loadStatement,
  mirrorToPeers,
  shape,
} from "@/lib/depositTaskAdmin";

/**
 * The client's proof of deposit, recorded by an ADMIN on their behalf.
 *
 * Clients normally answer "Deposit Funds Into Our Trust Account" in the portal.
 * But the money often arrives another way — the purchaser emails the wire
 * receipt to the clerk, drops a bank draft at the office, or simply can't work
 * the portal — and until now there was no way to put that receipt on the file:
 * the task stayed open, the milestone stayed short of complete, and the clerk
 * alert (which carries the receipt) never fired.
 *
 *   POST    record a proof the admin has just uploaded
 *   DELETE  remove one (?response_id= and/or ?doc_id=)
 *
 * The BYTES go up the same way every other admin upload does — browser →
 * Vercel Blob → /api/admin/uploadblobstorage with
 * doc_type="proof_of_deposit" — so the document lands in `lead_corporate_docs`
 * and shows up in the Documents modal and the client's portal exactly like a
 * client's own upload. This route only does the part that upload can't: write
 * the `task_responses` answer, complete the task, and fire the clerk email.
 *
 * That email is the same one the portal triggers through
 * /api/webhooks/deposit-proof, and for the same reason it is sent from here —
 * it attaches the receipt, and the blob-download plumbing lives in this repo.
 *
 * Gated to admins by src/middleware.ts.
 */

/** The document must be a proof_of_deposit on a lead belonging to THIS file. */
async function findProofDoc(fileUrl: string, leadIds: string[]) {
  if (leadIds.length === 0) return null;
  const { data } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_name, file_url, created_at")
    .eq("file_url", fileUrl)
    .eq("doc_type", PROOF_OF_DEPOSIT_DOC_TYPE)
    .in("lead_id", leadIds)
    .maybeSingle();
  return data ?? null;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    file_url?: unknown;
    file_name?: unknown;
  };
  const fileUrl = typeof body.file_url === "string" ? body.file_url.trim() : "";
  const fileName = typeof body.file_name === "string" ? body.file_name.trim() : "";

  // Only a stored blob can be recorded — the same guard uploadblobstorage
  // applies, so an arbitrary URL can never become a proof of deposit.
  if (!fileUrl || !isBlobUrl(fileUrl)) {
    return NextResponse.json(
      { success: false, error: "A stored file_url is required" },
      { status: 400 },
    );
  }

  const task = await loadDepositTask(id);
  if (!task) {
    return NextResponse.json(
      { success: false, error: "This file has no deposit task" },
      { status: 404 },
    );
  }

  const leads = await familyLeads(id);
  const leadIds = leads.map((l) => l.id);

  const doc = await findProofDoc(fileUrl, leadIds);
  if (!doc) {
    return NextResponse.json(
      { success: false, error: "That document is not a proof of deposit on this file" },
      { status: 404 },
    );
  }

  const field = await loadProofField(task.task_template_id);
  const fieldLabel = field?.label ?? PROOF_OF_DEPOSIT_FIELD_LABEL;
  const insertRow = {
    task_id: task.id,
    field_id: field?.id ?? null,
    field_label: fieldLabel,
    field_type: "file",
    value: null,
    file_url: fileUrl,
    file_name: fileName || doc.file_name,
  };

  // A retry (or a double-click) must not file the same receipt twice.
  const peers = await depositTaskPeers(task);
  const taskIds = [task.id, ...peers];
  const { data: existing } = await supabaseAdmin
    .from("task_responses")
    .select("task_id")
    .in("task_id", taskIds)
    .eq("field_type", "file")
    .eq("file_url", fileUrl);
  const alreadyOn = new Set((existing ?? []).map((r) => r.task_id as string));

  const rows = taskIds
    .filter((tid) => !alreadyOn.has(tid))
    .map((tid) => ({ ...insertRow, task_id: tid }));

  if (rows.length > 0) {
    const { error } = await supabaseAdmin.from("task_responses").insert(rows);
    if (error) {
      logger.error("[DepositProof POST] response insert failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  // A task still waiting on activation is off the client's dashboard AND out of
  // every rollup, so completing one would leave the milestone ignoring it.
  // Stamp it live — silently: the client is not being asked to pay money that
  // has already arrived, so no activation email goes out.
  if (!task.activated_at) {
    const activatedAt = new Date().toISOString();
    await supabaseAdmin
      .from("tasks")
      .update({ activated_at: activatedAt })
      .eq("id", task.id)
      .is("activated_at", null);
    await mirrorToPeers(task, { activated_at: activatedAt });
    task.activated_at = activatedAt;
  }

  let completed = false;
  try {
    completed = (await maybeCompleteFileTask(task.id)).completed;
  } catch (err) {
    logger.error("[DepositProof POST] auto-complete failed:", err);
  }

  // Fallback for a file whose task has no file field to key on — a legacy row
  // seeded before the 2026-08-26 migration, or one detached from its template.
  // maybeCompleteFileTask can only ever return false there, and the receipt IS
  // the task, so complete it directly rather than leaving the file open.
  if (!completed && !field && task.status !== "Completed") {
    const now = new Date().toISOString();
    const payload = { status: "Completed" as const, completed: true, completed_at: now };
    await supabaseAdmin.from("tasks").update(payload).eq("id", task.id);
    if (peers.length > 0) {
      await supabaseAdmin.from("tasks").update(payload).in("id", peers);
    }
    await recalcMilestonesForFamily(await getFamilyDealIds(task.deal_id), task.deal_id);
    completed = true;
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "deposit_proof.upload",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "tasks",
    resourceId: task.id,
    metadata: {
      deal_id: id,
      doc_id: doc.id,
      file_name: insertRow.file_name,
      on_behalf_of_client: true,
      task_completed: completed,
    },
    req,
  });

  // Same alert the portal triggers when a client uploads their own proof. It
  // downloads the receipt to attach it, so it runs after the response — and it
  // never throws, so it cannot fail this request.
  if (completed) {
    after(async () => {
      const result = await sendDepositProofEmail(task.id);
      logger.info(
        `[DepositProof] admin upload task=${task.id} sent=${result.sent}` +
          `${result.reason ? ` reason=${result.reason}` : ""}`,
      );
    });
  }

  const refreshed = await loadDepositTask(id);
  return NextResponse.json({
    success: true,
    task_completed: completed,
    ...shape(
      refreshed ?? task,
      await loadStatement(leadIds),
      await loadProofs(task.id, leadIds),
    ),
  });
}

// Remove a proof of deposit — a receipt filed against the wrong file, or one
// replaced by a corrected copy.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const responseId = url.searchParams.get("response_id");
  const docId = url.searchParams.get("doc_id");
  if (!responseId && !docId) {
    return NextResponse.json(
      { success: false, error: "response_id or doc_id is required" },
      { status: 400 },
    );
  }
  if ((responseId && !isUuid(responseId)) || (docId && !isUuid(docId))) {
    return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
  }

  const task = await loadDepositTask(id);
  if (!task) {
    return NextResponse.json(
      { success: false, error: "This file has no deposit task" },
      { status: 404 },
    );
  }

  const leads = await familyLeads(id);
  const leadIds = leads.map((l) => l.id);
  const peers = await depositTaskPeers(task);
  const taskIds = [task.id, ...peers];

  let fileUrl: string | null = null;
  let fileName: string | null = null;

  // Ownership, both stores: the response must belong to this file's deposit
  // task, the document to a lead on this file.
  if (responseId) {
    const { data: response } = await supabaseAdmin
      .from("task_responses")
      .select("id, task_id, file_url, file_name")
      .eq("id", responseId)
      .maybeSingle();
    if (!response || !taskIds.includes(response.task_id)) {
      return NextResponse.json({ success: false, error: "Response not found" }, { status: 404 });
    }
    fileUrl = response.file_url;
    fileName = response.file_name;
  }

  let doc: { id: string; lead_id: string; file_url: string | null; file_name: string | null } | null =
    null;
  if (docId) {
    const { data } = await supabaseAdmin
      .from("lead_corporate_docs")
      .select("id, lead_id, file_url, file_name")
      .eq("id", docId)
      .eq("doc_type", PROOF_OF_DEPOSIT_DOC_TYPE)
      .maybeSingle();
    if (!data || !leadIds.includes(data.lead_id)) {
      return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
    }
    doc = data;
    fileUrl = fileUrl ?? data.file_url;
    fileName = fileName ?? data.file_name;
  }

  // Drop the answer on every copy of the shared task, not just the one the
  // admin was looking at, or half the family keeps showing a receipt that is
  // no longer on the file.
  if (fileUrl) {
    await supabaseAdmin
      .from("task_responses")
      .delete()
      .in("task_id", taskIds)
      .eq("field_type", "file")
      .eq("file_url", fileUrl);
  } else if (responseId) {
    await supabaseAdmin.from("task_responses").delete().eq("id", responseId);
  }

  if (doc) {
    const { error } = await supabaseAdmin
      .from("lead_corporate_docs")
      .delete()
      .eq("id", doc.id);
    if (error) {
      logger.error("[DepositProof DELETE] doc delete failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }
  }

  // Best-effort blob cleanup — an orphaned file is untidy, not broken.
  if (fileUrl && isBlobUrl(fileUrl)) {
    try {
      await del(fileUrl, { token: blobTokenForUrl(fileUrl) });
    } catch (err) {
      logger.warn("[DepositProof DELETE] blob cleanup failed:", err);
    }
  }

  // With no receipt left, the task is not done. Leaving it Completed would have
  // the milestone — and the all-tasks-complete alert — report that the closing
  // funds arrived with nothing on the file to show for it.
  const proofs = await loadProofs(task.id, leadIds);
  let reopened = false;
  if (proofs.length === 0 && task.status === "Completed") {
    const payload = { status: "Pending" as const, completed: false, completed_at: null };
    await supabaseAdmin.from("tasks").update(payload).eq("id", task.id);
    if (peers.length > 0) {
      await supabaseAdmin.from("tasks").update(payload).in("id", peers);
    }
    await recalcMilestonesForFamily(await getFamilyDealIds(task.deal_id), task.deal_id);
    reopened = true;
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "deposit_proof.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "tasks",
    resourceId: task.id,
    metadata: { deal_id: id, doc_id: docId, response_id: responseId, file_name: fileName, reopened },
    req,
  });

  const refreshed = await loadDepositTask(id);
  return NextResponse.json({
    success: true,
    reopened,
    ...shape(refreshed ?? task, await loadStatement(leadIds), proofs),
  });
}
