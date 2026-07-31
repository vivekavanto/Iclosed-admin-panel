import { NextRequest, NextResponse } from "next/server";
import { maybeNotifyAllTasksComplete } from "@/lib/notifyAllTasksComplete";
import { guardServiceRequest } from "@/lib/verifyServiceSignature";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";

/**
 * POST /api/webhooks/tasks-complete
 *
 * Called by the customer portal every time a CLIENT completes a task.
 *
 * Why a webhook at all: clients finish their tasks in the portal, which writes
 * `tasks.status = 'Completed'` straight to the shared Supabase DB and runs its
 * own `advanceMilestone` — it never touches this app. So the admin-side hook in
 * recalcMilestones only ever sees ADMIN-driven completions. Without this route
 * the "your client has finished everything" alert would miss the exact case it
 * exists for.
 *
 * The handler is just a thin trigger: `maybeNotifyAllTasksComplete` re-reads the
 * whole family from the DB and owns the "is everything actually done?" decision
 * and the idempotency claim. So the portal can call this after EVERY task
 * completion — extra calls are cheap no-ops, and there's no state to keep in
 * sync across the two repos.
 *
 * Body: { deal_id: string }
 */
// SEC-017: server-to-server only — no CORS grant, preflight answered with 405.
export function OPTIONS() {
  return new NextResponse(null, { status: 405 });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    const blocked = guardServiceRequest(req, raw, { routeKey: "tasks-complete" });
    if (blocked) return blocked;

    const body = JSON.parse(raw) as { deal_id?: string };
    const dealId = body.deal_id;

    if (!isUuid(dealId)) {
      return NextResponse.json(
        { success: false, error: "deal_id (uuid) is required" },
        { status: 400 },
      );
    }

    const result = await maybeNotifyAllTasksComplete(dealId);

    return NextResponse.json({
      success: true,
      notified: result.notified,
      reason: result.reason,
      emailed_to: result.emailedTo ?? 0,
    });
  } catch (err: unknown) {
    logger.error("POST /api/webhooks/tasks-complete error:", err);
    // Don't leak internals to an unauthenticated caller.
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
