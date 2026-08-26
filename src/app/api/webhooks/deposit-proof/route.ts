import { NextRequest, NextResponse, after } from "next/server";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { sendDepositProofEmail } from "@/lib/sendDepositProofEmail";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhooks/deposit-proof
 *
 * Called by the customer portal the moment a CLIENT completes "Deposit Funds
 * Into Our Trust Account".
 *
 * Why a webhook: clients complete tasks in the portal, which writes straight to
 * the shared database and never touches this app — so nothing here would ever
 * learn that the closing funds had been sent. And the alert has to originate
 * HERE regardless, because it carries the proof of deposit as an attachment and
 * the blob-download plumbing lives in this repo (same reasoning as
 * /api/webhooks/tasks-complete).
 *
 * The handler is a thin trigger: sendDepositProofEmail re-reads the task from
 * the database and owns every decision — is this actually the deposit task, is
 * it actually complete, who should receive it. So the portal can call it after
 * any completion; a call for the wrong task is a cheap no-op.
 *
 * Body: { task_id: string }
 */
// SEC-017: server-to-server only — no CORS grant, preflight answered with 405.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "deposit-proof" });
    if (blocked) return blocked;

    const body = JSON.parse(raw) as { task_id?: string };
    if (!isUuid(body.task_id)) {
      return NextResponse.json(
        { success: false, error: "task_id (uuid) is required" },
        { status: 400 },
      );
    }
    const taskId = body.task_id as string;

    // Acknowledge first, send after. The portal calls this from inside the
    // client's own submission, and the send downloads the proof before Resend
    // takes it — holding the client on a spinner for that is not acceptable.
    // The caller therefore learns only that the trigger was ACCEPTED; the
    // decision and the logging both live in sendDepositProofEmail, which never
    // throws.
    after(async () => {
      const result = await sendDepositProofEmail(taskId);
      logger.info(
        `[deposit-proof] task=${taskId} sent=${result.sent}` +
          `${result.reason ? ` reason=${result.reason}` : ""}` +
          `${result.attached !== undefined ? ` attached=${result.attached}` : ""}`,
      );
    });

    return NextResponse.json({ success: true, accepted: true });
  } catch (err: unknown) {
    logger.error("POST /api/webhooks/deposit-proof error:", err);
    // Don't leak internals to an unauthenticated caller.
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
