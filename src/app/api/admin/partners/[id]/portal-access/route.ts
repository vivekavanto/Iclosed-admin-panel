import { NextRequest, NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";

// PUT { enabled } — removes or restores a partner's partner-portal sign-in.
// The portal checks portal_disabled_at on every request, so removal takes effect at once.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { enabled } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!isUuid(id) || typeof enabled !== "boolean") return NextResponse.json({ success: false, error: "enabled is required" }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from("partners")
    .update({ portal_disabled_at: enabled ? null : new Date().toISOString() })
    .eq("id", id)
    .eq("is_deleted", false)
    .select("id, auth_user_id, portal_joined_at, portal_disabled_at")
    .maybeSingle();
  if (error) {
    logger.error("[partners] portal access update failed:", error);
    const missing = error.code === "42703" || error.code === "PGRST204";
    return NextResponse.json(
      { success: false, error: missing ? "Run migrations/2026-10-27-partner-portal-accounts.sql first" : "Could not update portal access" },
      { status: missing ? 503 : 500 },
    );
  }
  if (!data) return NextResponse.json({ success: false, error: "Partner not found" }, { status: 404 });

  const actor = await getActingAdmin();
  await recordAudit({
    action: enabled ? "partner.portal_access_restored" : "partner.portal_access_removed",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "partner",
    resourceId: id,
    req,
  });
  return NextResponse.json({ success: true, partner: data });
}
