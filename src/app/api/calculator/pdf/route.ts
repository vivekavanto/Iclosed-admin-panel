import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import {
  buildEstimateRow,
  finalStatementBlocker,
  parseEstimatePayload,
} from "@/lib/closingEstimate";
import { closingCostPdfFileName, generateClosingCostPdf } from "@/lib/closingCostPdf";
import { formatLocalDate } from "@/lib/formatDate";

// POST /api/calculator/pdf
//
// The only PDF route the standalone calculator at /closing-cost-calculator has —
// it answers a signed-in admin and a clerk with no session alike. Renders the
// figures as a statement PDF and streams it back. NOTHING is persisted: no
// estimate row, no Blob upload, no audit of an issue that did not happen.
//
// The statement is recomputed HERE from the raw inputs through the same
// buildEstimateRow the deal routes use; the caller's totals are not read. So the
// PDF always matches the page it was taken from, and matches what the staff
// calculator would produce from the same numbers.
//
// PUBLIC: no session. Two things follow from that.
//
//   • This route WILL honour a firm, a statement type and fee overrides, because
//     the clerks it is shared with need them — the same reasons staff do. It is
//     therefore possible for anyone holding the URL to print a firm-letterhead
//     statement showing figures they chose. That is a property of the decision to
//     share the tool without a login, not of this handler; see
//     src/lib/publicCalculator.ts.
//
//   • The rate limit is keyed by IP and FAILS CLOSED. Every other limit in this
//     app protects a route already behind the admin gate, where locking staff out
//     over a database hiccup costs more than the limit protects (see
//     src/lib/rateLimit.ts). Here it is the reverse: rendering a PDF is the most
//     expensive thing an anonymous request can ask this app to do, so when the
//     limiter cannot answer, the safe reply is "not now".

/**
 * Per IP, and an office is ONE IP: staff and clerks behind the same connection
 * share this bucket, so it is sized for a room working through quotes rather
 * than for one person. Still far below what farming PDFs would need.
 */
const PDF_LIMIT = 60;
const PDF_WINDOW_SECONDS = 300;

export async function POST(req: Request) {
  const ip = requestIp(req);
  let allowed: boolean;
  try {
    allowed = await rateLimitOk(`pub-calc-pdf:${ip}`, PDF_LIMIT, PDF_WINDOW_SECONDS);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many PDFs from this connection. Please try again in a few minutes.",
      },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = parseEstimatePayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }
  if (parsed.payload.purchase_price <= 0) {
    return NextResponse.json(
      { success: false, error: "Enter a purchase price before downloading the PDF." },
      { status: 400 },
    );
  }

  // The firm decides the letterhead AND the fee schedule; the statement type
  // decides the title, the disclaimer and the watermark. Both fall back to the
  // configured defaults when the request does not name one.
  const [{ row: config, firmKey }, statementType] = await Promise.all([
    readActiveConfig(parsed.payload.firm_key),
    readStatementType(parsed.payload.statement_type),
  ]);

  // A final account may not go out carrying the planning placeholder — the same
  // rule the issue, email and staff-PDF routes apply.
  const blocker = finalStatementBlocker(
    statementType.type_key,
    parsed.payload.property_tax_adjustment,
  );
  if (blocker) {
    return NextResponse.json({ success: false, error: blocker }, { status: 400 });
  }

  const { columns, statement } = buildEstimateRow(
    { ...parsed.payload, firm_key: firmKey, statement_type: statementType.type_key },
    config,
    statementType,
  );

  const now = new Date().toISOString();

  try {
    const pdfBytes = await generateClosingCostPdf({
      statement,
      config,
      statementType,
      fileNo: parsed.payload.file_no_display,
      propertyAddress: parsed.payload.property_address,
      clientName: parsed.payload.purchasers,
      closingDate: parsed.payload.closing_date,
      preparedOn: formatLocalDate(now) || now.slice(0, 10),
      // Nothing printed from here has been issued to anyone. The statement type
      // still decides the watermark when it carries one — matching the staff
      // route, so the same inputs give the same document on both.
      draft: true,
      configVersion: (columns.config_version as string | null) ?? null,
    });

    return new NextResponse(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${closingCostPdfFileName(
          parsed.payload.file_no_display,
        )}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    // Detail stays in the server log: this response is public.
    logger.error("[Public calculator pdf] generation failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not generate the PDF." },
      { status: 500 },
    );
  }
}
