import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { latestDetailedExtract } from "@/lib/orchestrator/google-extracts";
import { applyBatch, getSnapshot, reportChecksum } from "@/lib/orchestrator/store";

export async function GET(request: NextRequest) {
  const secret = process.env.ORCHESTRATOR_CRON_SECRET;
  if (!secret || process.env.ORCHESTRATOR_IMPORT_ENABLED !== "true") return NextResponse.json({ error: "Daily refresh is not enabled." }, { status: 503 });
  const got = Buffer.from(request.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const { batch, csv, sourceId } = await latestDetailedExtract(today);
    const snapshot = await getSnapshot();
    const result = await applyBatch(batch, reportChecksum(batch.filename, csv), snapshot.revision, `daily-drive:${sourceId}`);
    return NextResponse.json({ imported: !result.duplicate, sourceDate: result.sourceDate, revision: result.revision });
  } catch (error) {
    // No client data or provider response bodies in health output.
    return NextResponse.json({ error: error instanceof Error ? error.message : "Daily refresh failed; existing data retained." }, { status: 409 });
  }
}
