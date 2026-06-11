import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";

// GET /api/admin/retainer-status?lead_ids=id1,id2,id3
//
// Returns the retainer-signed status for each requested lead. The Send Email
// modal calls this when the admin picks the "Retainer Agreement Signed"
// template so it can show a per-recipient badge before the admin clicks Send.
//
// Two tables matter here:
//   - retainer_signatures   → the signature is the source of truth that the
//                             client actually signed.
//   - lead_corporate_docs   → holds the generated PDF (doc_type =
//                             'retainer_agreement'). Without a PDF the email
//                             can't attach the signed copy.
//
// We surface both so the admin can tell a "fully signed" lead from one where
// the signature was captured but the async PDF step in iclosed_web's
// /api/retainer/sign route didn't complete (e.g., blob upload failed).
//
// Response shape:
//   { status: { [lead_id]: {
//       signed: boolean,        // signature row exists
//       has_pdf: boolean,       // lead_corporate_docs row exists
//       pdf_count: number,      // how many retainer PDFs are stored
//       signature_count: number // how many signature rows exist
//   } } }
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const leadIdsParam = searchParams.get("lead_ids");

  if (!leadIdsParam) {
    return NextResponse.json(
      { success: false, error: "lead_ids is required" },
      { status: 400 },
    );
  }

  const leadIds = leadIdsParam
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (leadIds.length === 0) {
    return NextResponse.json({ success: true, status: {} });
  }

  const { data: activeLeads, error: activeLeadsErr } = await supabaseAdmin
    .from("leads")
    .select("id")
    .in("id", leadIds)
    .eq("is_deleted", false);

  if (activeLeadsErr) {
    return NextResponse.json(
      { success: false, error: activeLeadsErr.message },
      { status: 500 },
    );
  }

  const activeLeadIds = (activeLeads ?? []).map((lead) => lead.id);

  const { data: activeDeals, error: activeDealsErr } = activeLeadIds.length > 0
    ? await supabaseAdmin
        .from("deals")
        .select("lead_id")
        .in("lead_id", activeLeadIds)
        .eq("is_deleted", false)
    : { data: [], error: null };

  if (activeDealsErr) {
    return NextResponse.json(
      { success: false, error: activeDealsErr.message },
      { status: 500 },
    );
  }

  const activeDealLeadIds = [
    ...new Set((activeDeals ?? []).map((deal) => deal.lead_id).filter(Boolean)),
  ];

  if (activeDealLeadIds.length === 0) {
    const status = Object.fromEntries(
      leadIds.map((id) => [
        id,
        { signed: false, has_pdf: false, pdf_count: 0, signature_count: 0 },
      ]),
    );
    return NextResponse.json({ success: true, status });
  }

  const [{ data: docs, error: docsErr }, { data: sigs, error: sigsErr }] =
    await Promise.all([
      supabaseAdmin
        .from("lead_corporate_docs")
        .select("lead_id, file_url")
        .in("lead_id", activeDealLeadIds)
        .eq("doc_type", "retainer_agreement"),
      supabaseAdmin
        .from("retainer_signatures")
        .select("lead_id")
        .in("lead_id", activeDealLeadIds),
    ]);

  if (docsErr || sigsErr) {
    return NextResponse.json(
      { success: false, error: (docsErr ?? sigsErr)?.message },
      { status: 500 },
    );
  }

  const status: Record<
    string,
    {
      signed: boolean;
      has_pdf: boolean;
      pdf_count: number;
      signature_count: number;
    }
  > = {};

  for (const id of leadIds) {
    status[id] = { signed: false, has_pdf: false, pdf_count: 0, signature_count: 0 };
  }
  for (const row of docs ?? []) {
    if (!row.file_url) continue;
    const entry = status[row.lead_id as string];
    if (!entry) continue;
    entry.has_pdf = true;
    entry.pdf_count += 1;
  }
  for (const row of sigs ?? []) {
    const entry = status[row.lead_id as string];
    if (!entry) continue;
    entry.signed = true;
    entry.signature_count += 1;
  }

  return NextResponse.json({ success: true, status });
}
