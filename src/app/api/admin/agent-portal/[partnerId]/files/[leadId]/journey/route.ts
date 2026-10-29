import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { loadAgentRootLead } from "@/lib/agentPortalData";
import { JOURNEY_TRACKING, ownershipResponsible, trackingTitle, type TrackingKey } from "@/lib/purchaseJourney";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { logger } from "@/lib/logger";

type Params = {params: Promise<{partnerId: string; leadId: string}>};
const fail = (error: string, status: number) => NextResponse.json({success: false, error}, {status});

// Staff-only endpoint under the existing agent-portal module gate. No client
// task, milestone, notification or document is changed by these manual records.
export async function PUT(req: NextRequest, {params}: Params) {
  const {partnerId, leadId} = await params;
  const body = await req.json().catch(() => null);
  if (!isUuid(partnerId) || !isUuid(leadId)) return fail("File not found", 404);
  if (!body || typeof body.key !== "string" || !Object.hasOwn(JOURNEY_TRACKING, body.key) || typeof body.completed !== "boolean" ||
      !(body.expectedCompletedAt === null || typeof body.expectedCompletedAt === "string")) return fail("Invalid progress update", 400);
  if (body.responsible !== undefined && (body.key !== "ownership" || !["Client", "iClosed"].includes(body.responsible))) return fail("Invalid responsibility", 400);
  try {
    const actor = await getActingAdmin();
    if (!actor.id) return fail("Sign in to update progress", 401);
    const root = await loadAgentRootLead(partnerId, leadId);
    if (!root) return fail("File not found", 404);
    const {data: deals, error: dealError} = await supabaseAdmin.from("deals").select("id, type, status").eq("lead_id", root).eq("is_deleted", false);
    if (dealError) throw dealError;
    if (!deals || deals.length !== 1 || !/purchase/i.test(deals[0].type ?? "")) return fail("A single purchase file is required", 409);
    const deal = deals[0];
    if (["Cancelled", "Inactive"].includes(deal.status ?? "") || (deal.status === "Closed" && !["keys", "ownership"].includes(body.key))) return fail("This file is locked", 409);
    const key = body.key as TrackingKey;
    const {data: lead, error: leadError} = await supabaseAdmin.from("leads").select("address_city").eq("id", root).single();
    if (leadError) throw leadError;
    // A deterministic UUID prevents duplicate rows across agents and retries.
    const hex = createHash("sha256").update(`agent-journey:${root}:${key}`).digest("hex");
    const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    const {data: existing, error: readError} = await supabaseAdmin.from("tasks").select("id, completed_at").eq("id", id).maybeSingle();
    if (readError) throw readError;
    if ((existing?.completed_at ?? null) !== body.expectedCompletedAt) return fail("Progress changed. Refresh the file and try again.", 409);
    const row = {id, deal_id: deal.id, title: trackingTitle(key, key === "ownership" ? (ownershipResponsible(lead?.address_city ?? null) === "Client" ? "Client" : body.responsible ?? "iClosed") : "iClosed"),
      // Remain inactive in the generic client-task pipeline so these records
      // cannot delay the existing all-client-tasks-complete notification.
      activation_required: true, activated_at: null,
      role_type: "Admin", side: "purchase", is_shared: true, is_deleted: false,
      milestone_id: null, task_template_id: null, completed: body.completed,
      status: body.completed ? "Completed" : "Pending", completed_at: body.completed ? existing?.completed_at ?? new Date().toISOString() : null};
    if (existing) {
      let query = supabaseAdmin.from("tasks").update(row).eq("id", id);
      query = existing.completed_at ? query.eq("completed_at", existing.completed_at) : query.is("completed_at", null);
      const {data, error} = await query.select("id");
      if (error) throw error;
      if (!data?.length) return fail("Progress changed. Refresh the file and try again.", 409);
    } else {
      const {error} = await supabaseAdmin.from("tasks").insert(row);
      if (error?.code === "23505") return fail("Progress changed. Refresh the file and try again.", 409);
      if (error) throw error;
    }
    await recordAudit({action: "agent_portal.journey_update", actorEmail: actor.email, actorUserId: actor.id,
      resourceType: "task", resourceId: id, metadata: {partnerId, rootLeadId: root, key, completed: body.completed}, req});
    return NextResponse.json({success: true});
  } catch (error) {
    logger.error("[agent-portal] journey update failed:", error);
    return fail("Could not update progress", 500);
  }
}
