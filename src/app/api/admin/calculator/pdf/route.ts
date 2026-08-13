import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimitOk } from "@/lib/rateLimit";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { readActiveConfig, readStatementType } from "@/lib/closingCostConfig";
import {
  buildEstimateRow,
  finalStatementBlocker,
  parseEstimatePayload,
} from "@/lib/closingEstimate";
import { closingCostPdfFileName, generateClosingCostPdf } from "@/lib/closingCostPdf";
import { formatLocalDate } from "@/lib/formatDate";

// POST /api/admin/calculator/pdf
//
// Renders the standalone calculator's figures as a statement PDF and streams it
// back. NOTHING is persisted: no estimate row, no Blob upload, no audit of an
// issue that did not happen. There is no GET counterpart for the same reason —
// with nothing stored there would be nothing for it to fetch.
//
// The statement is recomputed HERE from the raw inputs through the same
// buildEstimateRow the deal routes use; the client's totals are not read. So the
// PDF a clerk hands over always matches the page it was taken from, and always
// matches what the per-deal calculator would have produced from the same numbers.
//
// Gated to admins by src/middleware.ts.

export async function POST(req: Request) {
  // Per-admin rather than per-file: there is no file. Generous enough for a
  // clerk working through a list of quotes, tight enough that a stuck retry
  // loop cannot spin up unbounded PDF renders.
  const actor = await getActingAdmin();
  if (!(await rateLimitOk(`calc-pdf:${actor.id ?? actor.email ?? "unknown"}`, 30, 60))) {
    return NextResponse.json(
      { success: false, error: "Too many requests. Please wait a moment and try again." },
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
  // rule the issue and email routes apply. A PDF printed here can be handed to a
  // client just as easily as one that was issued, so it earns the same check.
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
      // still decides the watermark when it carries one — a "final account"
      // prints unmarked even though it was never issued, which is what the
      // per-deal PDF does too.
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
    logger.error("[Calculator pdf] generation failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not generate the PDF." },
      { status: 500 },
    );
  }
}
