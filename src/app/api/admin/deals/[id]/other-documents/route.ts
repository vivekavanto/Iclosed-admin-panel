import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";

// "Other Documents" (doc_type="other" on lead_corporate_docs), filed against
// the family's primary lead — same convention as PostClosureDocuments.
//
//   GET     list the family's "other" documents, plus the lead to upload against
//   PATCH   rename one (?doc_id=, body { label })
//   DELETE  remove one (?doc_id=)
//
// Uploading goes through /api/admin/uploadblobstorage(/token) — see OtherDocuments.tsx.
// Gated to admins by src/middleware.ts.

const OTHER_DOC_TYPE = "other";

async function primaryLeadId(dealId: string): Promise<string | null> {
  const familyDealIds = await getFamilyDealIds(dealId);
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .in("id", familyDealIds)
    .eq("is_deleted", false);

  const leadIds = [
    ...new Set((deals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
  ];
  if (leadIds.length === 0) return null;

  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select("id, parent_lead_id")
    .in("id", leadIds)
    .eq("is_deleted", false);

  return leads?.find((l) => !l.parent_lead_id)?.id ?? leadIds[0];
}

/** Every "other" document filed under any lead in this deal's family. */
async function familyDocs(dealId: string) {
  const familyDealIds = await getFamilyDealIds(dealId);
  const { data: deals } = await supabaseAdmin
    .from("deals")
    .select("lead_id")
    .in("id", familyDealIds)
    .eq("is_deleted", false);

  const leadIds = [
    ...new Set((deals ?? []).map((d) => d.lead_id).filter(Boolean) as string[]),
  ];
  if (leadIds.length === 0) return [];

  const { data, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_name, file_url, file_size, custom_type, created_at, hidden_from_client")
    .in("lead_id", leadIds)
    .eq("doc_type", OTHER_DOC_TYPE)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  try {
    const [documents, leadId] = await Promise.all([familyDocs(id), primaryLeadId(id)]);
    return NextResponse.json({ success: true, documents, lead_id: leadId });
  } catch (err) {
    logger.error("[OtherDocuments GET] read failed:", err);
    return NextResponse.json(
      {
        success: false,
        error:
          "Could not load Other Documents. Run the 2026-09-17 migration if this persists.",
      },
      { status: 500 },
    );
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const docId = new URL(req.url).searchParams.get("doc_id");
  if (!docId || !isUuid(docId)) {
    return NextResponse.json({ success: false, error: "Invalid document id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { label?: unknown; hidden_from_client?: unknown }
    | null;

  const docs = await familyDocs(id);
  const doc = docs.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
  }

  const update: { custom_type?: string | null; hidden_from_client?: boolean } = {};
  if (typeof body?.label === "string") {
    update.custom_type = body.label.trim() || null;
  }
  if (typeof body?.hidden_from_client === "boolean") {
    update.hidden_from_client = body.hidden_from_client;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: "Nothing to update" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .update(update)
    .eq("id", docId);

  if (error) {
    logger.error("[OtherDocuments PATCH] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ success: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const docId = new URL(req.url).searchParams.get("doc_id");
  if (!docId || !isUuid(docId)) {
    return NextResponse.json({ success: false, error: "Invalid document id" }, { status: 400 });
  }

  // Ownership: the document must belong to a lead on THIS file.
  const docs = await familyDocs(id);
  const doc = docs.find((d) => d.id === docId);
  if (!doc) {
    return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .delete()
    .eq("id", docId);

  if (error) {
    logger.error("[OtherDocuments DELETE] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  // Best-effort blob cleanup — an orphaned file is untidy, not broken.
  if (doc.file_url && isBlobUrl(doc.file_url)) {
    try {
      await del(doc.file_url, { token: blobTokenForUrl(doc.file_url) });
    } catch (err) {
      logger.warn("[OtherDocuments DELETE] blob cleanup failed:", err);
    }
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "other_document.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead_corporate_docs",
    resourceId: docId,
    metadata: { deal_id: id, file_name: doc.file_name },
    req,
  });

  return NextResponse.json({ success: true });
}
