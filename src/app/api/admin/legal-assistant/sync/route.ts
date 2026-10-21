import { NextRequest, NextResponse } from "next/server";
import { getStaff } from "@/lib/orchestrator/server-auth";
import { canManageOrchestrator } from "@/lib/orchestrator/permissions";
import { getDetailedExtract } from "@/lib/orchestrator/google-extracts";
import { applyBatch, getSnapshot, reportChecksum } from "@/lib/orchestrator/store";
import { reconcile } from "@/lib/orchestrator/closer-import";

export async function POST(request: NextRequest) {
  const user = await getStaff();
  if (!user || !canManageOrchestrator(user)) return NextResponse.json({ error:"Administrator access required." }, { status:403 });
  if (request.headers.get("origin") !== request.nextUrl.origin) return NextResponse.json({ error:"Invalid origin." }, { status:403 });
  try {
    const body = await request.json();
    if (!["preview", "apply"].includes(body.action)) throw new Error("Invalid refresh request.");
    const today = new Intl.DateTimeFormat("en-CA",{timeZone:"America/Toronto",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
    const { batch, csv, sourceId } = await getDetailedExtract(today, false);
    const checksum = reportChecksum(batch.filename, csv), snapshot = await getSnapshot();
    if (body.action === "preview") return NextResponse.json({ batch, counts:reconcile(snapshot.matters,batch), revision:snapshot.revision, checksum, sourceId });
    if (process.env.ORCHESTRATOR_IMPORT_ENABLED !== "true") throw new Error("Imports are not enabled.");
    if (body.sourceId !== sourceId || body.checksum !== checksum || !Number.isSafeInteger(body.expectedRevision)) throw new Error("The extract changed. Review the current report before applying it.");
    return NextResponse.json(await applyBatch(batch, checksum, body.expectedRevision, user.id));
  } catch (error) { return NextResponse.json({error:error instanceof Error ? error.message : "Drive refresh failed. Existing data retained."},{status:409}); }
}
