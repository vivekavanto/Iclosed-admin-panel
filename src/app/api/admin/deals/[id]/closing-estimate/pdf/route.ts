import { NextResponse } from "next/server";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { isUuid } from "@/lib/isUuid";
import { logger } from "@/lib/logger";
import { rateLimitOk } from "@/lib/rateLimit";
import { blobTokenForUrl, isBlobUrl, isPrivateBlobUrl } from "@/lib/blobPrivacy";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import { configFromSnapshot } from "@/lib/closingCostConfigSnapshot";
import { snapshotToStatement } from "@/lib/closingEstimate";
import { closingCostPdfFileName, generateClosingCostPdf } from "@/lib/closingCostPdf";
import { formatLocalDate } from "@/lib/formatDate";

// GET /api/admin/deals/[id]/closing-estimate/pdf[?estimate_id=…&draft=1]
//
// Streams the estimate PDF back as an attachment.
//
//   • An ISSUED estimate serves the stored Blob artifact when it exists, so the
//     admin panel and the customer portal hand out byte-identical files. If the
//     upload leg failed at issue time it is regenerated from the frozen snapshot.
//   • A DRAFT is always generated fresh and watermarked, and is never persisted.
//
// Returns bytes directly rather than going through /api/admin/documents/download,
// which resolves authorisation against lead_corporate_docs — a table this
// feature deliberately does not write to.

const supabase = supabaseAdmin;

/** The subset of `deal_closing_estimates` this route renders from. */
interface EstimateRow {
  id: string;
  status: string | null;
  file_no_display: string | null;
  line_items: unknown;
  pdf_url: string | null;
  issued_at: string | null;
  updated_at: string | null;
  // Added by 2026-08-03 / 2026-08-04. Optional because a row read before those
  // migrations simply will not carry them, and a historic estimate must stay
  // printable either way.
  firm_key?: string | null;
  statement_type?: string | null;
  purchasers?: string | null;
  property_address?: string | null;
  closing_date?: string | null;
  // Added by 2026-08-08. Null on any row written before it.
  config_snapshot?: unknown;
  config_version?: string | null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ success: false, error: "Invalid deal id" }, { status: 400 });
  }

  if (!(await rateLimitOk(`cc-pdf:${id}`, 30, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    );
  }

  const url = new URL(req.url);
  const estimateId = url.searchParams.get("estimate_id");
  const wantDraft = url.searchParams.get("draft") === "1";

  if (estimateId && !isUuid(estimateId)) {
    return NextResponse.json(
      { success: false, error: "Invalid estimate id" },
      { status: 400 },
    );
  }

  // ── Resolve which estimate row to render ──
  let row: EstimateRow | null = null;

  if (estimateId) {
    const { data } = await supabase
      .from("deal_closing_estimates")
      .select("*")
      .eq("id", estimateId)
      // Scope to the deal in the path so an id from another file can't be read
      // through this route.
      .eq("deal_id", id)
      .eq("is_deleted", false)
      .maybeSingle();
    row = data ?? null;
  } else if (wantDraft) {
    const { data } = await supabase
      .from("deal_closing_estimates")
      .select("*")
      .eq("deal_id", id)
      .eq("status", "draft")
      .eq("is_deleted", false)
      .maybeSingle();
    row = data ?? null;
  } else {
    const { data } = await supabase
      .from("deal_closing_estimates")
      .select("*")
      .eq("deal_id", id)
      .eq("status", "issued")
      .eq("is_deleted", false)
      .order("issued_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = data ?? null;
    if (!row) {
      const { data: fallbackDraft } = await supabase
        .from("deal_closing_estimates")
        .select("*")
        .eq("deal_id", id)
        .eq("status", "draft")
        .eq("is_deleted", false)
        .maybeSingle();
      row = fallbackDraft ?? null;
    }
  }

  if (!row) {
    return NextResponse.json(
      { success: false, error: "No closing cost estimate saved for this file yet." },
      { status: 404 },
    );
  }

  const isDraft = row.status !== "issued";
  const fileName = closingCostPdfFileName(row.file_no_display);

  // ── Serve the stored artifact for an issued estimate ──
  if (!isDraft && row.pdf_url && isBlobUrl(row.pdf_url)) {
    try {
      const upstream = await fetch(row.pdf_url, {
        headers: isPrivateBlobUrl(row.pdf_url)
          ? { Authorization: `Bearer ${blobTokenForUrl(row.pdf_url)}` }
          : undefined,
        cache: "no-store",
      });
      if (upstream.ok) {
        const bytes = await upstream.arrayBuffer();
        return new NextResponse(bytes, {
          status: 200,
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "private, no-store",
          },
        });
      }
      logger.warn(
        "[ClosingEstimate pdf] stored blob unreadable, regenerating:",
        upstream.status,
      );
    } catch (err) {
      logger.warn("[ClosingEstimate pdf] blob fetch failed, regenerating:", err);
    }
  }

  // ── Regenerate from the frozen snapshot ──
  const statement = snapshotToStatement(row.line_items);
  if (!statement) {
    return NextResponse.json(
      { success: false, error: "This estimate has no saved figures to render." },
      { status: 409 },
    );
  }

  const { data: deal } = await supabase
    .from("deals")
    .select("file_number, property_address")
    .eq("id", id)
    .maybeSingle();

  // The letterhead and the wording come from the estimate's own FROZEN
  // snapshot, so a re-download reproduces the document the client received —
  // not today's version of it. That is the promise Settings → Closing costs
  // makes on screen ("changing these affects new estimates only"), and reading
  // the live config here is precisely how it used to be broken.
  //
  // Only a row written before the snapshot column existed falls back to the
  // live config, which is what such a row has always rendered from anyway.
  const frozen = configFromSnapshot(row.config_snapshot);
  let config: Record<string, unknown>;
  let statementType: Awaited<ReturnType<typeof readStatementType>>;

  if (frozen) {
    config = frozen.config;
    statementType = frozen.statementType;
  } else {
    config = (await readActiveConfig(row.firm_key as string | null)).row;
    // An estimate saved before statement types existed has no stored flavour;
    // fall back to the workflow status, which reproduces the old watermark rule.
    statementType = await readStatementType(
      (row.statement_type as string | null) ?? (isDraft ? "draft" : "final"),
    );
  }

  try {
    const preparedSource: string =
      (row.issued_at as string | null) ?? (row.updated_at as string | null) ?? "";
    const pdfBytes = await generateClosingCostPdf({
      statement,
      config,
      statementType,
      fileNo: row.file_no_display ?? deal?.file_number ?? null,
      propertyAddress:
        (row.property_address as string | null) ?? deal?.property_address ?? null,
      clientName: (row.purchasers as string | null) ?? null,
      closingDate: (row.closing_date as string | null) ?? null,
      preparedOn: formatLocalDate(preparedSource) || preparedSource.slice(0, 10),
      draft: isDraft,
      configVersion: row.config_version ?? null,
    });

    return new NextResponse(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    logger.error("[ClosingEstimate pdf] generation failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not generate the PDF." },
      { status: 500 },
    );
  }
}
