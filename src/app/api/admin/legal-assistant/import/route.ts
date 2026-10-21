import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";
import { parseCloserReport, reconcile } from "@/lib/orchestrator/closer-import";
import { applyBatch, getSnapshot, reportChecksum } from "@/lib/orchestrator/store";

export async function POST(request: NextRequest) {
  const user = await getStaff();
  if (!user || !canManageOrchestrator(user)) return NextResponse.json({ error: "Administrator access required." }, { status: 403 });
  if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  if (Number(request.headers.get("content-length") ?? "0") > 12_000_000) return NextResponse.json({ error: "Report too large." }, { status: 413 });
  try {
    const raw = await request.text();
    if (raw.length > 12_000_000) throw new Error("Report too large.");
    const body = JSON.parse(raw);
    if (typeof body.csv !== "string" || typeof body.filename !== "string" || !["preview", "apply"].includes(body.action)) throw new Error("Invalid import request.");
    const batch = parseCloserReport(body.filename, body.csv);
    const checksum = reportChecksum(body.filename, body.csv);
    if (body.action === "apply") {
      if (process.env.ORCHESTRATOR_IMPORT_ENABLED !== "true") return NextResponse.json({ error: "Live imports have not been enabled." }, { status: 409 });
      if (body.checksum !== checksum || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("Review this exact extract before applying it.");
      return NextResponse.json(await applyBatch(batch, checksum, body.expectedRevision, user.id));
    }
    const snapshot = await getSnapshot();
    return NextResponse.json({ counts: reconcile(snapshot.matters, batch), revision: snapshot.revision, checksum });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed." }, { status: 400 });
  }
}
