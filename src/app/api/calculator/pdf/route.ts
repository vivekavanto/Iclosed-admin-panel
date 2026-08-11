import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { rateLimitOk, requestIp } from "@/lib/rateLimit";
import { closingCostPdfFileName, generateClosingCostPdf } from "@/lib/closingCostPdf";
import {
  computePublicEstimate,
  parsePublicEstimatePayload,
} from "@/lib/publicClosingEstimate";

// POST /api/calculator/pdf — the public estimator's "Download PDF".
//
// PUBLIC BY DESIGN (outside /api/admin/*, so middleware.ts never runs on it).
//
// POST rather than GET even though it reads nothing: the figures are the
// visitor's own financial details, and a GET would put their purchase price and
// mortgage amount in the URL — into browser history, referer headers and every
// access log between here and them.
//
// Nothing is written. No estimate row, no blob, no lead. The bytes are generated
// and streamed; the only trace is the rate-limit counter.

/** Generating a PDF costs real CPU, so an anonymous caller gets a tight budget. */
const PDF_LIMIT = 10;
const PDF_WINDOW_SECONDS = 60;

export async function POST(req: Request) {
  const ip = requestIp(req);
  if (!(await rateLimitOk(`pub-cc-pdf:${ip}`, PDF_LIMIT, PDF_WINDOW_SECONDS))) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many downloads from this connection. Please wait a minute and try again.",
      },
      { status: 429 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request." },
      { status: 400 },
    );
  }

  const parsed = parsePublicEstimatePayload(body);
  if ("error" in parsed) {
    return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  }

  try {
    const { statement, config, statementType } = await computePublicEstimate(parsed.input);

    const pdfBytes = await generateClosingCostPdf({
      statement,
      config,
      statementType,
      clientName: parsed.input.clientName,
      // No file number and no property: a public estimate belongs to no file, and
      // printing a blank "File No." line would imply one had been opened.
      fileNo: null,
      propertyAddress: null,
      closingDate: null,
      preparedOn: new Date().toLocaleDateString("en-CA", {
        month: "long",
        day: "numeric",
        year: "numeric",
      }),
      draft: true,
    });

    return new NextResponse(pdfBytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${closingCostPdfFileName(null)}"`,
        // The visitor's own figures — never let a shared cache hold them.
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    // Detail to the server log, a generic message to a stranger.
    logger.error("[PublicCalculator pdf] generation failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not generate the PDF. Please try again." },
      { status: 500 },
    );
  }
}
