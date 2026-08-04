import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { getFamilyDealIds } from "@/lib/familyDeals";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import {
  FINAL_REPORT_DOC_TYPE,
  FINAL_REPORT_LEAD_COLUMNS,
} from "@/lib/sendFinalReportEmail";

// Post-closure documents for one deal.
//
//   GET     list the final reports on the file, plus who could receive them
//   DELETE  remove one (?doc_id=)
//
// Uploading goes through the existing /api/admin/uploadblobstorage endpoint
// with doc_type="final_report" — that route already writes to
// `lead_corporate_docs`, which is what makes the report show up in the admin
// Documents modal and the client's portal Documents page for free.
//
// Gated to admins by src/middleware.ts.

/** Everyone on the file, so the caller can decide who to email. */
async function familyLeads(dealId: string) {
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

  const { data: leads } = await supabaseAdmin
    .from("leads")
    .select(FINAL_REPORT_LEAD_COLUMNS)
    .in("id", leadIds)
    .eq("is_deleted", false)
    // Primary first, then co-persons, so the UI lists them in a sensible order.
    .order("parent_lead_id", { ascending: true, nullsFirst: true });

  return leads ?? [];
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  const leads = await familyLeads(id);
  if (leads.length === 0) {
    return NextResponse.json({ success: true, documents: [], recipients: [] });
  }

  const { data: documents, error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_name, file_url, side, created_at, emailed_at, emailed_to")
    .in(
      "lead_id",
      leads.map((l) => l.id),
    )
    .eq("doc_type", FINAL_REPORT_DOC_TYPE)
    .order("created_at", { ascending: false });

  if (error) {
    logger.error("[FinalReport GET] read failed:", error.message);
    return NextResponse.json(
      {
        success: false,
        error:
          "Could not load the post-closure documents. Run the 2026-08-06 migration if this persists.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    success: true,
    documents: documents ?? [],
    // The lead the upload should be filed against — the primary, so the whole
    // family can see it regardless of which co-person is being viewed.
    primary_lead_id: leads.find((l) => !l.parent_lead_id)?.id ?? leads[0].id,
    recipients: leads.map((l) => ({
      lead_id: l.id,
      name: `${l.first_name ?? ""} ${l.last_name ?? ""}`.trim(),
      email: l.email,
      is_primary: !l.parent_lead_id,
    })),
  });
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
  const leads = await familyLeads(id);
  const leadIds = leads.map((l) => l.id);

  const { data: doc } = await supabaseAdmin
    .from("lead_corporate_docs")
    .select("id, lead_id, file_url, file_name")
    .eq("id", docId)
    .eq("doc_type", FINAL_REPORT_DOC_TYPE)
    .maybeSingle();

  if (!doc || !leadIds.includes(doc.lead_id)) {
    return NextResponse.json({ success: false, error: "Document not found" }, { status: 404 });
  }

  const { error } = await supabaseAdmin
    .from("lead_corporate_docs")
    .delete()
    .eq("id", docId);

  if (error) {
    logger.error("[FinalReport DELETE] failed:", error.message);
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  // Best-effort blob cleanup — an orphaned file is untidy, not broken.
  if (doc.file_url && isBlobUrl(doc.file_url)) {
    try {
      await del(doc.file_url, { token: blobTokenForUrl(doc.file_url) });
    } catch (err) {
      logger.warn("[FinalReport DELETE] blob cleanup failed:", err);
    }
  }

  const actor = await getActingAdmin();
  await recordAudit({
    action: "final_report.delete",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "lead_corporate_docs",
    resourceId: docId,
    metadata: { deal_id: id, file_name: doc.file_name },
    req,
  });

  return NextResponse.json({ success: true });
}
