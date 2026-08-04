import { NextResponse } from "next/server";
import { put } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/recordAudit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { BLOB_ACCESS, blobToken } from "@/lib/blobPrivacy";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import { buildEstimateRow, parseEstimatePayload } from "@/lib/closingEstimate";
import { generateClosingCostPdf } from "@/lib/closingCostPdf";
import { formatLocalDate } from "@/lib/formatDate";

// POST /api/admin/deals/[id]/closing-estimate/issue
//
// Turns the working draft into an ISSUED estimate: recomputes the statement,
// freezes the snapshot, generates the one-page PDF, uploads it to Vercel Blob,
// and records the URL on the row. The customer portal reads the latest issued
// row, so this is the moment the client can see it.
//
// The PDF is deliberately NOT written into lead_corporate_docs — that table
// drives the existing admin Documents modal and the portal Documents view, and
// an estimate is not a client document.

const supabase = supabaseAdmin;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  // PDF generation + a blob upload per call, so cap it.
  if (!(await rateLimitOk(`cc-issue:${id}`, 10, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // An empty body is fine — it means "issue whatever the saved draft holds".
    body = {};
  }

  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .select("id, file_number, property_address, lead_id, is_deleted")
    .eq("id", id)
    .maybeSingle();

  if (dealErr) {
    logger.error("[ClosingEstimate issue] deal read failed:", dealErr.message);
    return NextResponse.json(
      { success: false, error: "Could not load the file" },
      { status: 500 },
    );
  }
  if (!deal || deal.is_deleted) {
    return NextResponse.json({ success: false, error: "File not found" }, { status: 404 });
  }

  const { data: draft } = await supabase
    .from("deal_closing_estimates")
    .select("*")
    .eq("deal_id", id)
    .eq("status", "draft")
    .eq("is_deleted", false)
    .maybeSingle();

  // Inputs come from the request when supplied (so "Issue" can save-and-issue in
  // one click), otherwise from the stored draft.
  const source = Object.keys(body).length > 0 ? body : (draft ?? null);
  if (!source) {
    return NextResponse.json(
      { success: false, error: "There is no draft estimate to issue. Save one first." },
      { status: 400 },
    );
  }

  // A request body carries `rate_overrides` at the top level; a stored draft
  // keeps them nested inside its frozen `rates_used` snapshot.
  const sourceRow = source as Record<string, unknown>;
  const nestedRates = sourceRow.rates_used as Record<string, unknown> | null | undefined;
  const sourceOverrides =
    sourceRow.rate_overrides ?? nestedRates?.rate_overrides ?? {};

  const parsed = parseEstimatePayload({
    ...sourceRow,
    rate_overrides: sourceOverrides,
  });
  if ("error" in parsed) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  if (parsed.payload.purchase_price <= 0) {
    return NextResponse.json(
      { success: false, error: "Enter a purchase price before issuing the estimate." },
      { status: 400 },
    );
  }

  // The firm decides the letterhead AND the fee schedule; the statement type
  // decides the title, the disclaimer and the watermark. Both fall back to the
  // configured defaults when the estimate does not name one.
  const { row: config, firmKey } = await readActiveConfig(parsed.payload.firm_key);
  const statementType = await readStatementType(parsed.payload.statement_type);
  const { columns, statement } = buildEstimateRow(
    { ...parsed.payload, firm_key: firmKey, statement_type: statementType.type_key },
    config,
  );

  const actor = await getActingAdmin();
  const now = new Date().toISOString();
  const fileNo = parsed.payload.file_no_display ?? deal.file_number ?? null;

  // 1. Insert the issued row FIRST, so a PDF failure can never lose the issue
  //    itself (the PDF is regenerable from the frozen snapshot at any time).
  const { data: issued, error: insertErr } = await supabase
    .from("deal_closing_estimates")
    .insert([
      {
        ...columns,
        deal_id: id,
        status: "issued",
        issued_at: now,
        created_by_email: actor.email,
        updated_at: now,
      },
    ])
    .select("*")
    .single();

  if (insertErr) {
    logger.error("[ClosingEstimate issue] insert failed:", insertErr.message);
    return NextResponse.json(
      { success: false, error: insertErr.message },
      { status: 400 },
    );
  }

  // 2. Generate + upload the PDF. Non-blocking for the response status: the
  //    estimate is already issued and durable, and the download route can
  //    regenerate on demand if this leg failed.
  let pdfUrl: string | null = null;
  let pdfError: string | null = null;
  try {
    const pdfBytes = await generateClosingCostPdf({
      statement,
      config,
      statementType,
      fileNo,
      propertyAddress: parsed.payload.property_address ?? deal.property_address ?? null,
      clientName: parsed.payload.purchasers ?? null,
      closingDate: parsed.payload.closing_date ?? null,
      preparedOn: formatLocalDate(now) || now.slice(0, 10),
    });

    const blob = await put(
      `closing-estimates/${id}/${Date.now()}-estimated-closing-costs.pdf`,
      Buffer.from(pdfBytes),
      { access: BLOB_ACCESS, token: blobToken()! },
    );
    pdfUrl = blob.url;

    const { error: urlErr } = await supabase
      .from("deal_closing_estimates")
      .update({
        pdf_url: blob.url,
        pdf_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", issued.id);
    if (urlErr) throw new Error(`pdf_url update failed: ${urlErr.message}`);
  } catch (err) {
    pdfError = err instanceof Error ? err.message : "PDF generation failed";
    logger.error("[ClosingEstimate issue] PDF/blob step failed (non-blocking):", err);
  }

  // 3. Clear the draft so the next edit starts from the issued figures rather
  //    than a stale working copy. Soft delete keeps the history intact.
  if (draft?.id) {
    try {
      await supabase
        .from("deal_closing_estimates")
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq("id", draft.id);
    } catch (err) {
      logger.error("[ClosingEstimate issue] draft cleanup failed (non-blocking):", err);
    }
  }

  await recordAudit({
    action: "closing_estimate.issue",
    actorEmail: actor.email,
    actorUserId: actor.id,
    resourceType: "deal",
    resourceId: id,
    metadata: {
      estimate_id: issued.id,
      total_closing_costs: statement.total,
      balance_due: statement.balance.balanceDue,
      pdf_stored: Boolean(pdfUrl),
    },
    req,
  });

  return NextResponse.json({
    success: true,
    data: { ...issued, pdf_url: pdfUrl },
    statement,
    // Surfaced so the UI can say "issued, but the PDF needs regenerating".
    pdf_error: pdfError,
  });
}
