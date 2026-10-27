import { NextRequest, NextResponse } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { blobTokenForUrl, isBlobUrl } from "@/lib/blobPrivacy";
import { logger } from "@/lib/logger";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { recordAudit } from "@/lib/recordAudit";
import { AGENT_UPLOAD_PREFIX } from "@/lib/agentPortal";
import { loadAgentRootLead } from "@/lib/agentPortalData";
import { findAgentDocument, listAgentDocuments, OTHER_DOC_TYPE } from "@/lib/agentFileExtras";

type Params = { params: Promise<{ partnerId: string; leadId: string }> };

const LABEL_MAX = 120;

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

// The agent's Other Documents (doc_type "other" on the root lead), internal until shared.
// POST records an upload, PATCH { docId, label?, shared? }, DELETE ?docId=.
async function context(req: NextRequest, params: Params["params"]) {
  const { partnerId, leadId } = await params;
  if (!isUuid(partnerId) || !isUuid(leadId)) return null;
  const root = await loadAgentRootLead(partnerId, leadId);
  if (!root) return null;
  const actor = await getActingAdmin();
  const audit = (action: string, metadata: Record<string, unknown>) =>
    recordAudit({ action, actorEmail: actor.email, actorUserId: actor.id, resourceType: "lead", resourceId: root, metadata: { partnerId, ...metadata }, req });
  return { root, audit };
}

export async function POST(req: NextRequest, { params }: Params) {
  const { fileUrl, fileName, fileSize } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const ctx = await context(req, params);
    if (!ctx) return fail("File not found", 404);
    if (typeof fileUrl !== "string" || !isBlobUrl(fileUrl) || typeof fileName !== "string" || !fileName.trim()) return fail("A Blob file URL and file name are required", 400);
    if (!new URL(fileUrl).pathname.startsWith(`/${AGENT_UPLOAD_PREFIX}/${ctx.root}/`)) return fail("Invalid upload path", 400);
    const { error } = await supabaseAdmin.from("lead_corporate_docs").insert({
      lead_id: ctx.root,
      doc_type: OTHER_DOC_TYPE,
      file_url: fileUrl,
      file_name: fileName.trim(),
      file_size: typeof fileSize === "number" ? fileSize : null,
      hidden_from_client: true,
    });
    if (error) throw error;
    await ctx.audit("partner.document_upload", { fileName });
    return NextResponse.json({ success: true, documents: await listAgentDocuments(ctx.root) });
  } catch (err) {
    logger.error("[agent-portal] other document upload failed:", err);
    return fail("Could not save the document", 500);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { docId, label, shared } = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const ctx = await context(req, params);
    if (!ctx) return fail("File not found", 404);
    const doc = typeof docId === "string" && isUuid(docId) ? await findAgentDocument(ctx.root, docId) : null;
    if (!doc) return fail("Document not found", 404);
    const update: Record<string, unknown> = {};
    if (typeof label === "string") update.custom_type = label.trim().slice(0, LABEL_MAX) || null;
    if (typeof shared === "boolean") update.hidden_from_client = !shared;
    if (Object.keys(update).length === 0) return fail("Nothing to update", 400);
    const { error } = await supabaseAdmin.from("lead_corporate_docs").update(update).eq("id", doc.id);
    if (error) throw error;
    await ctx.audit("partner.document_update", { docId: doc.id, ...update });
    return NextResponse.json({ success: true, documents: await listAgentDocuments(ctx.root) });
  } catch (err) {
    logger.error("[agent-portal] other document update failed:", err);
    return fail("Could not update the document", 500);
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const docId = new URL(req.url).searchParams.get("docId");
  try {
    const ctx = await context(req, params);
    if (!ctx) return fail("File not found", 404);
    const doc = docId && isUuid(docId) ? await findAgentDocument(ctx.root, docId) : null;
    if (!doc) return fail("Document not found", 404);
    const { error } = await supabaseAdmin.from("lead_corporate_docs").delete().eq("id", doc.id);
    if (error) throw error;
    if (doc.fileUrl) await del(doc.fileUrl, { token: blobTokenForUrl(doc.fileUrl) }).catch((e) => logger.warn("[agent-portal] blob delete failed:", e));
    await ctx.audit("partner.document_delete", { docId: doc.id, fileName: doc.fileName });
    return NextResponse.json({ success: true, documents: await listAgentDocuments(ctx.root) });
  } catch (err) {
    logger.error("[agent-portal] other document delete failed:", err);
    return fail("Could not remove the document", 500);
  }
}
