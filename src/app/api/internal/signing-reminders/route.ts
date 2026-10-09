import { NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runSigningReminders } from "@/lib/signingReminders";
import { logger } from "@/lib/logger";

/**
 * GET /api/internal/signing-reminders — daily Vercel Cron (see vercel.json).
 *
 * Outside /api/admin, so middleware never runs; the caller proves itself with
 * `Authorization: Bearer $CRON_SECRET`, which Vercel Cron sends automatically
 * when CRON_SECRET is set. FAILS CLOSED: with no CRON_SECRET configured every
 * request is refused.
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
    logger.warn("[SigningReminders] rejected: bad or missing CRON_SECRET");
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await runSigningReminders();
    return NextResponse.json({ success: true, ...result });
  } catch {
    return NextResponse.json({ success: false, error: "Run failed" }, { status: 500 });
  }
}
