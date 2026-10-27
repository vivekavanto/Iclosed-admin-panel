import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { getLeadFirmKey } from "@/lib/leadFirm";
import { loadAgentPortalPartner, loadAgentRootLead } from "@/lib/agentPortalData";
import { createPermissionRequest, loadAgentPermission, MISSING_TABLE_CODES, withdrawAgentPermission } from "@/lib/agentTaskPermission";
import { sendAgentPermissionEmail } from "@/lib/sendAgentPermissionEmail";

// POST { leadId (root lead), action: "request" | "withdraw" } — emails the client
// a permission request, or cancels it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ partnerId: string }> }) {
  const { partnerId } = await params;
  const { leadId, action } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!isUuid(partnerId) || typeof leadId !== "string" || !isUuid(leadId) || (action !== "request" && action !== "withdraw")) {
    return NextResponse.json({ success: false, error: "leadId and action are required" }, { status: 400 });
  }

  try {
    if (!(await loadAgentRootLead(partnerId, leadId))) return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
    const actor = await getActingAdmin();
    const audit = (auditAction: string, metadata: Record<string, unknown> = {}) =>
      recordAudit({ action: auditAction, actorEmail: actor.email, actorUserId: actor.id, resourceType: "lead", resourceId: leadId, metadata: { partnerId, ...metadata }, req });

    if (action === "withdraw") {
      await withdrawAgentPermission(partnerId, leadId);
      await audit("partner.task_permission_withdrawn");
      return NextResponse.json({ success: true, permission: await loadAgentPermission(partnerId, leadId) });
    }

    const { data: fileDeal } = await supabaseAdmin.from("deals").select("status").eq("lead_id", leadId).eq("is_deleted", false).maybeSingle();
    if (["Closed", "Cancelled", "Inactive"].includes(fileDeal?.status ?? "")) {
      return NextResponse.json({ success: false, error: `This file is ${fileDeal?.status?.toLowerCase()}` }, { status: 409 });
    }
    if ((await loadAgentPermission(partnerId, leadId)).status === "granted") {
      return NextResponse.json({ success: false, error: "The client has already given permission" }, { status: 409 });
    }
    const [partner, { data: lead }, { data: deal }] = await Promise.all([
      loadAgentPortalPartner(partnerId),
      supabaseAdmin.from("leads").select("first_name, email").eq("id", leadId).maybeSingle(),
      supabaseAdmin.from("deals").select("property_address, selling_property_address, type").eq("lead_id", leadId).eq("is_deleted", false).maybeSingle(),
    ]);
    const email = lead?.email?.trim();
    if (!partner) return NextResponse.json({ success: false, error: "Partner not found" }, { status: 404 });
    if (!email) return NextResponse.json({ success: false, error: "The client has no email address on file" }, { status: 400 });

    const token = await createPermissionRequest(partnerId, leadId, email);
    const sent = await sendAgentPermissionEmail({
      to: email,
      firm: await getLeadFirmKey(leadId),
      clientFirstName: lead?.first_name ?? null,
      agentName: partner.agent_name?.trim() || "Your agent",
      brokerage: partner.brokerage_name,
      property: deal?.property_address || deal?.selling_property_address || null,
      token,
    });
    if (!sent.ok) {
      // The link never reached the client, so don't leave it looking requested.
      await withdrawAgentPermission(partnerId, leadId);
      return NextResponse.json({ success: false, error: sent.error || "The email could not be sent" }, { status: 502 });
    }
    await audit("partner.task_permission_requested", { to: email });
    return NextResponse.json({ success: true, permission: await loadAgentPermission(partnerId, leadId) });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code && MISSING_TABLE_CODES.has(code)) {
      return NextResponse.json({ success: false, error: "Run migrations/2026-10-27-agent-task-permissions.sql first" }, { status: 503 });
    }
    logger.error("[agent-portal] permission update failed:", err);
    return NextResponse.json({ success: false, error: "Could not update permission" }, { status: 500 });
  }
}
