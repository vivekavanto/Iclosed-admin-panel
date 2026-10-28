import { NextRequest, NextResponse } from "next/server";
import { dailyCloserRefresh } from "@/lib/orchestrator/daily-refresh";
import { latestDetailedExtract } from "@/lib/orchestrator/google-extracts";
import { applyBatch, getSnapshot, reportChecksum } from "@/lib/orchestrator/store";

// Legacy machine endpoint retains both its staff gate and dedicated secret.
// Vercel Cron uses /api/internal/legal-assistant/refresh instead.
export async function GET(request: NextRequest) {
  const result=await dailyCloserRefresh(request.headers.get("authorization"),{
    secret:process.env.ORCHESTRATOR_CRON_SECRET,enabled:process.env.ORCHESTRATOR_IMPORT_ENABLED==="true",
  },{snapshot:getSnapshot,extract:latestDetailedExtract,checksum:reportChecksum,apply:applyBatch});
  return NextResponse.json(result.body,{status:result.status,headers:{"Cache-Control":"private, no-store"}});
}
