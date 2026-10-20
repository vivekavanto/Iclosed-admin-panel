import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { sendClientTaskReminder } from "@/lib/clientTaskReminder";

// POST /api/admin/deals/[id]/remind-client
//
// The admin's "Remind client" button: emails everyone on this file (every client
// sharing the deal's file_number) ONE reminder to complete their pending tasks.
// Unlike the automatic reminder this can be sent as often as the admin likes; it
// does stamp clients.task_reminder_sent_at so the automatic one never follows.
//
// Gated to admins by src/middleware.ts.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const { data: deal } = await supabaseAdmin
      .from("deals")
      .select("id, file_number, client_id")
      .eq("id", id)
      .maybeSingle();
    if (!deal) {
      return NextResponse.json({ success: false, error: "Deal not found" }, { status: 404 });
    }

    const clientIds = new Set<string>();
    if (deal.client_id) clientIds.add(deal.client_id);
    if (deal.file_number) {
      const { data: family } = await supabaseAdmin
        .from("deals")
        .select("client_id")
        .eq("file_number", deal.file_number);
      for (const d of family ?? []) if (d.client_id) clientIds.add(d.client_id);
    }

    const result = await sendClientTaskReminder([...clientIds]);

    if (result.ok) {
      const actor = await getActingAdmin();
      await recordAudit({
        action: "client.task_reminder",
        actorEmail: actor.email,
        actorUserId: actor.id,
        resourceType: "deals",
        resourceId: id,
        metadata: { pending: result.pendingCount, recipients: result.sent.length },
        req,
      });
    }

    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: result.reason ?? "Could not send the reminder" },
        { status: 400 },
      );
    }
    return NextResponse.json({
      success: true,
      recipients: result.sent,
      pending: result.pendingCount,
    });
  } catch (err) {
    logger.error("[RemindClient] failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not send the reminder" },
      { status: 500 },
    );
  }
}
