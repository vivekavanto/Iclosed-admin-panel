import { NextRequest, NextResponse, after } from "next/server";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { notifyAdminsOfClientMessage } from "@/lib/dealMessages";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhooks/client-message
 *
 * Called by the customer portal after a client posts a message in the portal
 * chat. The portal writes the message straight to the shared deal_messages
 * table; this just raises the staff bell (idempotent per message id).
 *
 * Body: { message_id: string }
 */
// Server-to-server only — no CORS grant, preflight answered with 405.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "client-message" });
    if (blocked) return blocked;

    const body = JSON.parse(raw) as { message_id?: string };
    if (!isUuid(body.message_id)) {
      return NextResponse.json(
        { success: false, error: "message_id (uuid) is required" },
        { status: 400 },
      );
    }
    const messageId = body.message_id as string;

    after(async () => {
      const raised = await notifyAdminsOfClientMessage(messageId);
      logger.info(`[client-message] message=${messageId} notified=${raised}`);
    });
    return NextResponse.json({ success: true, accepted: true });
  } catch (err) {
    logger.error("POST /api/webhooks/client-message error:", err);
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
