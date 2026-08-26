import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { resolvePrimaryDealId } from "@/lib/primaryDeal";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { findFamilySharedTaskPeers } from "@/lib/findFamilySharedTaskPeers";
import { STATEMENT_OF_ACCOUNT_DOC_TYPE, isTaskInactive } from "@/lib/depositTask";
import {
  sendDepositTaskEmail,
  DEPOSIT_TASK_LEAD_COLUMNS,
} from "@/lib/sendDepositTaskEmail";

// The admin half of the closing-funds task.
//
//   GET     the task's current state + the Final Statement of Account on file
//   PATCH   save the balance due (autosaved as the admin types/extracts it)
//   POST    activate: show the task to the client and email them
//   DELETE  remove the statement (?doc_id=), so it can be replaced
//
// The statement itself is UPLOADED through the shared
// /api/admin/uploadblobstorage endpoint with doc_type="statement_of_account" —
// the same route the final report uses. That writes to `lead_corporate_docs`,
// which is what puts the document in the admin Documents modal and the client's
// portal Documents page without any work here.
//
// Gated to admins by src/middleware.ts.

/** Everyone on the file, primary first. */
async function familyLeads(dealId: string) {
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
async function loadDepositTask(dealId: string) {
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
  return data ?? null;
}

/** The statement lives on the family's PRIMARY lead so everyone can see it. */
async function loadStatement(leadIds: string[]) {
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
 * Legacy files can carry a copy of a shared task on a co-person's deal (rows
 * created before shared tasks were consolidated). Mirror writes to them so the
 * two never disagree about the balance or whether the task is live.
 */
async function mirrorToPeers(
  task: { id: string; deal_id: string; task_template_id: string | null; title: string | null },
  patch: Record<string, unknown>,
) {
  try {
    const peers = await findFamilySharedTaskPeers({
      sourceTaskId: task.id,
      dealId: task.deal_id,
      taskTemplateId: task.task_template_id,
      title: task.title,
      isApsTask: false,
    });
    if (peers.length === 0) return;
    await supabaseAdmin.from("tasks").update(patch).in("id", peers);
  } catch (err) {
    logger.warn("[DepositTask] peer mirror failed (non-blocking):", err);
  }
}

function shape(
  task: Awaited<ReturnType<typeof loadDepositTask>>,
  statement: Awaited<ReturnType<typeof loadStatement>>,
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
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const leads = await familyLeads(id);
    const [task, statement] = await Promise.all([
      loadDepositTask(id),
      loadStatement(leads.map((l) => l.id)),
    ]);

    return NextResponse.json({
      success: true,
      ...shape(task, statement),
      // The lead the statement should be filed against — the primary, so every
      // co-person sees it.
      primary_lead_id: leads.find((l) => !l.parent_lead_id)?.id ?? leads[0]?.id ?? null,
      recipients: leads.map((l) => ({
        lead_id: l.id,
        name: `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim(),
        email: l.email,
        is_primary: !l.parent_lead_id,
      })),
    });
  } catch (err) {
    logger.error("[DepositTask GET] failed:", err);
    return NextResponse.json(
      {
        success: false,
        error:
          "Could not load the deposit task. Run the 2026-08-26 migration if this persists.",
      },
      { status: 500 },
    );
  }
}

// Save the balance due. Separate from activation on purpose: the figure is
// typed (or AI-extracted) first and the admin may correct it before switching
// the task on, so this must not have side effects the client can see.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { balance_due?: unknown };

  // NULL clears the figure; anything else must be a non-negative number. A
  // balance is money the client owes us, so a negative is a typo, not a credit.
  let balanceDue: number | null = null;
  if (body.balance_due !== null && body.balance_due !== undefined && body.balance_due !== "") {
    const parsed = Number(String(body.balance_due).replace(/[^0-9.\-]/g, ""));
    if (!Number.isFinite(parsed) || parsed < 0) {
      return NextResponse.json(
        { success: false, error: "Enter the balance due as a positive amount" },
        { status: 400 },
      );
    }
    balanceDue = parsed;
  }

  const task = await loadDepositTask(id);
  if (!task) {
    return NextResponse.json(
      { success: false, error: "This file has no deposit task" },
      { status: 404 },
    );
  }

  const { error } = await supabaseAdmin
    .from("tasks")
    .update({ balance_due: balanceDue })
    .eq("id", task.id);

  if (error) {
    logger.error("[DepositTask PATCH] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  await mirrorToPeers(task, { balance_due: balanceDue });

  const leads = await familyLeads(id);
  return NextResponse.json({
    success: true,
    ...shape({ ...task, balance_due: balanceDue }, await loadStatement(leads.map((l) => l.id))),
  });
}

// Activate: put the task on the client's dashboard and tell them it's there.
//
// Body: { resend?: true } re-sends the notification for a task that is ALREADY
// active. Without it an activated task is a no-op, so a double-click can't email
// the client twice — but a client who deleted the email, or one sent before a
// detail was corrected, would otherwise leave the admin with no way to get it
// back to them short of editing the database.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { resend?: unknown };
  const resend = body.resend === true;

  const task = await loadDepositTask(id);
  if (!task) {
    return NextResponse.json(
      { success: false, error: "This file has no deposit task" },
      { status: 404 },
    );
  }

  const leads = await familyLeads(id);
  const statement = await loadStatement(leads.map((l) => l.id));

  // Both are mandatory — the task is unanswerable without them, and the button
  // that calls this is disabled until they're present. Re-checked here because
  // a disabled button is a convenience, not a control.
  if (!statement?.file_url) {
    return NextResponse.json(
      { success: false, error: "Upload the Final Statement of Account first" },
      { status: 400 },
    );
  }
  if (task.balance_due === null || task.balance_due === undefined) {
    return NextResponse.json(
      { success: false, error: "Enter the balance due on closing first" },
      { status: 400 },
    );
  }

  if (task.activated_at && !resend) {
    // Already live. Not an error — a double-click must not send the client a
    // second "new task" email.
    return NextResponse.json({
      success: true,
      already_active: true,
      ...shape(task, statement),
    });
  }

  // An explicit resend leaves activated_at alone: the task went live when it
  // first went live, and rewriting that would misreport when the client was
  // actually given the work.
  const activatedAt = task.activated_at ?? new Date().toISOString();

  if (!task.activated_at) {
    const { error } = await supabaseAdmin
      .from("tasks")
      .update({ activated_at: activatedAt })
      .eq("id", task.id)
      .is("activated_at", null);

    if (error) {
      logger.error("[DepositTask POST] activation failed:", error.message);
      return NextResponse.json({ success: false, error: error.message }, { status: 400 });
    }

    await mirrorToPeers(task, { activated_at: activatedAt });
  }

  const { data: deal } = await supabaseAdmin
    .from("deals")
    .select("file_number, closing_date")
    .eq("id", task.deal_id)
    .maybeSingle();

  // The email is the point of the button, so its outcome is reported back
  // rather than swallowed — but a send failure must not undo the activation:
  // the task IS live, and the admin can re-notify or call the client.
  const email = await sendDepositTaskEmail({
    leads,
    fileNumber: deal?.file_number ?? null,
    closingDate: deal?.closing_date ?? null,
    balanceDue: Number(task.balance_due),
    statement,
  });

  const actor = await getActingAdmin();
  await recordAudit({
    action: resend ? "deposit_task.resend" : "deposit_task.activate",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "tasks",
    resourceId: task.id,
    metadata: {
      deal_id: id,
      balance_due: task.balance_due,
      statement_doc_id: statement.id,
      notified: email.sent,
    },
    req,
  });

  return NextResponse.json({
    success: true,
    resent: resend,
    notified: email.sent,
    email_error: email.error ?? null,
    ...shape({ ...task, activated_at: activatedAt }, statement),
  });
}

// Remove the statement so a corrected one can be uploaded in its place.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const docId = new URL(req.url).searchParams.get("doc_id");
  if (!docId || !isUuid(docId)) {
    return NextResponse.json({ success: false, error: "Invalid document id" }, { status: 400 });
  }

  // Ownership: the document must belong to a lead on THIS file.
  const leads = await familyLeads(id);
  const leadIds = leads.map((l) => l.id);

  const { data: doc } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_url, file_name")
    .eq("id", docId)
    .eq("doc_type", STATEMENT_OF_ACCOUNT_DOC_TYPE)
    .maybeSingle();

  if (!doc || !leadIds.includes(doc.lead_id)) {
    return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
  }

  const { error } = await supabaseAdmin.from("lead_corporate_docs").delete().eq("id", docId);
  if (error) {
    logger.error("[DepositTask DELETE] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  // Best-effort blob cleanup — an orphaned file is untidy, not broken.
  if (doc.file_url && isBlobUrl(doc.file_url)) {
    try {
      await del(doc.file_url, { token: blobTokenForUrl(doc.file_url) });
    } catch (err) {
      logger.warn("[DepositTask DELETE] blob cleanup failed:", err);
    }
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "statement_of_account.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead_corporate_docs",
    resourceId: docId,
    metadata: { deal_id: id, file_name: doc.file_name },
    req,
  });

  return NextResponse.json({ success: true });
}
