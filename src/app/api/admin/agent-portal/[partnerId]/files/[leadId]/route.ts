import { NextRequest, NextResponse } from "next/server";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { loadAgentRootLead } from "@/lib/agentPortalData";
import { AGENT_NOTE_MAX, listAgentDocuments, loadAgentNote, saveAgentNote } from "@/lib/agentFileExtras";
import { MISSING_TABLE_CODES } from "@/lib/agentTaskPermission";

type Params = { params: Promise<{ partnerId: string; leadId: string }> };

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

/** The file's root lead when it is one of this agent's files. */
async function rootFor(partnerId: string, leadId: string) {
  if (!isUuid(partnerId) || !isUuid(leadId)) return null;
  return loadAgentRootLead(partnerId, leadId);
}

// GET — the agent's Other Documents and note on one file (leadId is the root lead).
export async function GET(_req: NextRequest, { params }: Params) {
  const { partnerId, leadId } = await params;
  try {
    const root = await rootFor(partnerId, leadId);
    if (!root) return fail("File not found", 404);
    const [documents, note] = await Promise.all([listAgentDocuments(root), loadAgentNote(partnerId, root)]);
    return NextResponse.json({ success: true, documents, note });
  } catch (err) {
    logger.error("[agent-portal] file extras load failed:", err);
    return fail("Could not load documents and notes", 500);
  }
}

// PUT { note } — the agent's private notes on this file. Empty clears it.
export async function PUT(req: NextRequest, { params }: Params) {
  const { partnerId, leadId } = await params;
  const { note } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (typeof note !== "string" || note.trim().length > AGENT_NOTE_MAX) return fail(`A note of up to ${AGENT_NOTE_MAX} characters is required`, 400);
  try {
    const root = await rootFor(partnerId, leadId);
    if (!root) return fail("File not found", 404);
    await saveAgentNote(partnerId, root, note.trim());
    const actor = await getActingAdmin();
    await recordAudit({ action: "partner.note_update", actorEmail: actor.email, actorUserId: actor.id, resourceType: "lead", resourceId: root, metadata: { partnerId, length: note.trim().length }, req });
    return NextResponse.json({ success: true, note: await loadAgentNote(partnerId, root) });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code && MISSING_TABLE_CODES.has(code)) return fail("Run migrations/2026-10-27-agent-file-notes.sql first", 503);
    logger.error("[agent-portal] note save failed:", err);
    return fail("Could not save the note", 500);
  }
}
