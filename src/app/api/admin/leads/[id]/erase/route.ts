import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";

/**
 * POST /api/admin/leads/[id]/erase
 *
 * CMP-005 — right-to-be-forgotten / data erasure. HARD-deletes a lead and its
 * whole family (co-purchasers/co-sellers) plus everything hanging off them:
 * deals, tasks, milestones, task responses, corporate + identification docs,
 * retainer signatures — and the underlying Blob objects. This is irreversible;
 * it is NOT the reversible soft-delete used by the normal delete button.
 *
 * Gated by the admin auth middleware. Requires an explicit confirmation + reason
 * in the body, and writes an audit_logs row recording who erased what and why.
 *
 * Body: { confirm: true, reason: string, deleteClientAndAuth?: boolean }
 *
 * By default the linked `clients` row and its Supabase auth user are LEFT intact
 * (a client can be shared across files). Pass deleteClientAndAuth:true to also
 * remove the client + auth login IF no other leads still reference that client.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "Invalid lead id" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({} as any));
  if (body?.confirm !== true) {
    return NextResponse.json(
      { error: "Erasure must be confirmed with { confirm: true }" },
      { status: 400 },
    );
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason) {
    return NextResponse.json(
      { error: "A reason is required for erasure" },
      { status: 400 },
    );
  }
  const deleteClientAndAuth = body?.deleteClientAndAuth === true;

  // ── 1. Resolve the family (root + children) ─────────────────────────────
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id, client_id")
    .eq("id", id)
    .maybeSingle();
  if (leadErr) {
    return NextResponse.json({ error: leadErr.message }, { status: 500 });
  }
  if (!lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const rootLeadId = lead.parent_lead_id ?? lead.id;
  const { data: familyLeads } = await supabaseAdmin
    .from("leads")
    .select("id, client_id")
    .or(`id.eq.${rootLeadId},parent_lead_id.eq.${rootLeadId}`);

  const leadIds = (familyLeads ?? []).map((l) => l.id as string);
  if (leadIds.length === 0) leadIds.push(lead.id);
  const clientIds = Array.from(
    new Set((familyLeads ?? []).map((l) => l.client_id).filter(Boolean)),
  ) as string[];

  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("id")
    .in("lead_id", leadIds);
  const dealIds = (deals ?? []).map((d) => d.id as string);

  const { data: tasks } = dealIds.length
    ? await supabaseAdmin.from("tasks").select("id").in("deal_id", dealIds)
    : { data: [] as { id: string }[] };
  const taskIds = (tasks ?? []).map((t) => t.id as string);

  // ── 2. Collect blob URLs to delete from storage ─────────────────────────
  const blobUrls = new Set<string>();
  async function collectUrls(table: string, col: string, ids: string[]) {
    if (!ids.length) return;
    const { data } = await supabaseAdmin
      .from(table)
      .select("file_url")
      .in(col, ids);
    for (const r of data ?? []) {
      const u = (r as any).file_url as string | null;
      if (u) blobUrls.add(u);
    }
  }
  await collectUrls("lead_corporate_docs", "lead_id", leadIds);
  await collectUrls("lead_identification_docs", "lead_id", leadIds);
  await collectUrls("task_responses", "task_id", taskIds);
  await collectUrls("deal_documents", "deal_id", dealIds);

  const errors: string[] = [];

  // ── 3. Delete blob bytes (best-effort) ──────────────────────────────────
  if (blobUrls.size && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      await del(Array.from(blobUrls), {
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
    } catch (err: any) {
      errors.push(`blob del: ${err?.message ?? "failed"}`);
    }
  }

  // ── 4. Delete DB rows child→parent (best-effort; collect errors) ────────
  async function wipe(table: string, col: string, ids: string[]) {
    if (!ids.length) return;
    const { error } = await supabaseAdmin.from(table).delete().in(col, ids);
    if (error) errors.push(`${table}: ${error.message}`);
  }
  // Duplicate/legacy tables are wiped too so no PII copy survives; ignore
  // "table does not exist" errors by not treating them as fatal.
  await wipe("task_responses", "task_id", taskIds);
  await wipe("tasks", "deal_id", dealIds);
  await wipe("tasks_duplicate", "deal_id", dealIds);
  await wipe("milestones", "deal_id", dealIds);
  await wipe("milestones_duplicate", "deal_id", dealIds);
  await wipe("deal_documents", "deal_id", dealIds);
  await wipe("deal_notes", "deal_id", dealIds);
  await wipe("deal_co_purchasers", "deal_id", dealIds);
  await wipe("deals", "lead_id", leadIds);
  await wipe("deals_duplicate", "lead_id", leadIds);
  await wipe("retainer_signatures", "lead_id", leadIds);
  await wipe("lead_corporate_docs", "lead_id", leadIds);
  await wipe("lead_identification_docs", "lead_id", leadIds);
  await wipe("leads", "id", leadIds);

  // ── 5. Optionally remove the client + auth login if now orphaned ────────
  let clientsDeleted = 0;
  if (deleteClientAndAuth) {
    for (const clientId of clientIds) {
      const { count } = await supabaseAdmin
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      if ((count ?? 0) > 0) continue; // still referenced — keep it
      const { data: client } = await supabaseAdmin
        .from("clients")
        .select("auth_user_id")
        .eq("id", clientId)
        .maybeSingle();
      const { error: cErr } = await supabaseAdmin
        .from("clients")
        .delete()
        .eq("id", clientId);
      if (cErr) {
        errors.push(`clients: ${cErr.message}`);
        continue;
      }
      clientsDeleted++;
      const authUserId = (client as any)?.auth_user_id as string | null;
      if (authUserId) {
        try {
          await supabaseAdmin.auth.admin.deleteUser(authUserId);
        } catch (err: any) {
          errors.push(`auth delete: ${err?.message ?? "failed"}`);
        }
      }
    }
  }

  // ── 6. Audit ────────────────────────────────────────────────────────────
  const actor = await getActingAdmin();
  await recordAudit({
    action: "lead.erase",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead",
    resourceId: rootLeadId,
    metadata: {
      reason,
      lead_ids: leadIds,
      deal_ids: dealIds,
      task_ids_count: taskIds.length,
      blobs_deleted: blobUrls.size,
      clients_deleted: clientsDeleted,
      deleteClientAndAuth,
      errors,
    },
    req,
  });

  return NextResponse.json({
    success: errors.length === 0,
    erased: {
      leads: leadIds.length,
      deals: dealIds.length,
      tasks: taskIds.length,
      blobs: blobUrls.size,
      clients: clientsDeleted,
    },
    errors,
  });
}
