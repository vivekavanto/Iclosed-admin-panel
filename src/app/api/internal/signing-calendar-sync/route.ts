import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { syncCancelledFromCalendar } from "@/lib/signingCalendarSync";
import { logger } from "@/lib/logger";

/**
 * GET /api/internal/signing-calendar-sync — marks appointments cancelled when
 * their Google Calendar event was cancelled/deleted on the calendar itself.
 *
 * Outside /api/admin, so middleware never runs; same auth as signing-reminders:
 * `Authorization: Bearer $CRON_SECRET`, FAILS CLOSED when CRON_SECRET is unset.
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
    logger.warn("[SigningCalendarSync] rejected: bad or missing CRON_SECRET");
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await syncCancelledFromCalendar();
    return NextResponse.json({ success: true, ...result });
  } catch {
    return NextResponse.json({ success: false, error: "Run failed" }, { status: 500 });
  }
}
