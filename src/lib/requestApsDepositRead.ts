import { computeServiceSignature } from "@/lib/verifyServiceSignature";
import { logger } from "@/lib/logger";

// Asks the customer portal to read the deposit off an agreement staff just
// uploaded. The APS reader lives in the portal (iclosed_dev_web), so an admin
// upload has to hand the files over; a client's own upload does this inside the
// portal. Signed with SERVICE_WEBHOOK_SECRET, verified by the portal's
// /api/internal/aps-deposit.
//
// Best-effort by design: the upload is already saved and the task completed, so
// a portal that is down or not yet deployed must never fail the upload. The
// deposit simply stays as entered, and staff can edit it.

const TIMEOUT_MS = 10_000;

export async function requestApsDepositRead(opts: {
  dealId: string;
  side: "purchase" | "sale" | null;
  fileUrls: string[];
}): Promise<void> {
  const portal = (process.env.NEXT_PUBLIC_CUSTOMER_PORTAL_URL ?? "").trim().replace(/\/+$/, "");
  const secret = process.env.SERVICE_WEBHOOK_SECRET ?? "";
  if (!portal || !secret) {
    logger.warn("[aps-deposit] portal URL or SERVICE_WEBHOOK_SECRET not set; deposit not read");
    return;
  }

  // Sign the exact string that is sent — never re-serialize.
  const body = JSON.stringify(opts);
  const timestamp = String(Date.now());
  try {
    const res = await fetch(`${portal}/api/internal/aps-deposit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-iClosed-Timestamp": timestamp,
        "X-iClosed-Signature": computeServiceSignature(timestamp, body),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`[aps-deposit] portal answered ${res.status} for deal ${opts.dealId}`);
    }
  } catch (err) {
    logger.warn(
      `[aps-deposit] could not reach portal for deal ${opts.dealId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
