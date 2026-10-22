import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { loadAgentPortalPartner, loadNotificationTemplates, MISSING_TABLE_CODES } from "@/lib/agentPortalData";

type Params = { params: Promise<{ partnerId: string }> };

// GET — the opt-in task templates plus which ones this agent has selected.
// One setting per agent, applied across all of their clients' files.
export async function GET(_req: NextRequest, { params }: Params) {
  const { partnerId } = await params;
  if (!isUuid(partnerId)) return NextResponse.json({ success: false, error: "Invalid partner id" }, { status: 400 });

  try {
    const templates = await loadNotificationTemplates();
    const { data, error } = await supabaseAdmin
      .from("partner_notification_settings")
      .select("task_template_ids, updated_at, updated_by")
      .eq("partner_id", partnerId)
      .maybeSingle();
    if (error && MISSING_TABLE_CODES.has(error.code)) {
      return NextResponse.json({ success: true, schemaReady: false, templates, selected: [] });
    }
    if (error) throw error;
    return NextResponse.json({
      success: true,
      schemaReady: true,
      templates,
      selected: data?.task_template_ids ?? [],
      updatedAt: data?.updated_at ?? null,
      updatedBy: data?.updated_by ?? null,
    });
  } catch (err) {
    logger.error("[agent-portal] notification settings load failed:", err);
    return NextResponse.json({ success: false, error: "Could not load notification settings" }, { status: 500 });
  }
}

// PUT { taskTemplateIds: string[] } — replace the agent's opted-in list.
export async function PUT(req: NextRequest, { params }: Params) {
  const { partnerId } = await params;
  if (!isUuid(partnerId)) return NextResponse.json({ success: false, error: "Invalid partner id" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const ids: unknown = body?.taskTemplateIds;
  if (!Array.isArray(ids) || !ids.every(isUuid)) {
    return NextResponse.json({ success: false, error: "taskTemplateIds must be a list of ids" }, { status: 400 });
  }
  if (!(await loadAgentPortalPartner(partnerId))) {
    return NextResponse.json({ success: false, error: "Partner not found" }, { status: 404 });
  }

  const actor = await getActingAdmin();
  const taskTemplateIds = [...new Set(ids as string[])];
  const { error } = await supabaseAdmin.from("partner_notification_settings").upsert({
    partner_id: partnerId,
    task_template_ids: taskTemplateIds,
    updated_by: actor.email,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    logger.error("[agent-portal] notification settings save failed:", error);
    const missing = MISSING_TABLE_CODES.has(error.code);
    return NextResponse.json(
      { success: false, error: missing ? "Run migrations/2026-10-22-partner-notification-settings.sql first" : "Could not save notification settings" },
      { status: missing ? 503 : 500 },
    );
  }

  await recordAudit({
    action: "partner.notification_settings.update",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "partner",
    resourceId: partnerId,
    metadata: { count: taskTemplateIds.length },
    req,
  });
  return NextResponse.json({ success: true, selected: taskTemplateIds });
}
