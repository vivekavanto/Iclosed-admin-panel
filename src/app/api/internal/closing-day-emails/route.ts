import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runClosingDayEmails } from "@/lib/closingDayEmail";
import { logger } from "@/lib/logger";

/**
 * GET /api/internal/closing-day-emails — Vercel Cron, 9AM office time: "Your Closing Day Update" to each client whose file closes today (see vercel.json).
 *
 * Fires at 13:00 and 14:00 UTC; the run itself no-ops unless it is 9AM in the
 * office timezone, which covers daylight saving. Add `?force=1` to bypass the
 * hour guard for a manual run.
 *
 * Outside /api/admin, so middleware never runs; the caller proves itself with
 * `Authorization: Bearer $CRON_SECRET`. FAILS CLOSED: with no CRON_SECRET
 * configured every request is refused.
 */
export const runtime = "nodejs";
export const maxDuration = 120;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  if (!authorised(req)) {
    logger.warn("[ClosingDay] rejected: bad or missing CRON_SECRET");
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const result = await runClosingDayEmails(new Date(), { force });
    return NextResponse.json({ success: true, ...result });
  } catch {
    return NextResponse.json({ success: false, error: "Run failed" }, { status: 500 });
  }
}
