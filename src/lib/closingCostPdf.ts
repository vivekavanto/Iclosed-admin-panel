// Server-side one-page "Estimated Statement of Account" PDF.
//
// Built with pdf-lib (already a dependency) rather than the jsPDF path in
// dealPdf.ts, because this runs in a route handler: the bytes are uploaded to
// Vercel Blob once at issue time so the admin panel and the customer portal
// serve the byte-identical artifact. dealPdf.ts is deliberately left untouched —
// it is on the existing task/deal download path.
//
// Everything on the letterhead comes from `closing_cost_config`, so the firm's
// address / phone / HST number can be corrected from the settings page without a
// deploy.

import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { DISCLAIMERS, type Statement } from "./closingCosts";

export interface ClosingCostPdfParams {
  statement: Statement;
  /** The `closing_cost_config` row supplying the letterhead. */
  config: Record<string, unknown>;
  fileNo?: string | null;
  propertyAddress?: string | null;
  clientName?: string | null;
  /** Stamped in the footer. Pass an ISO string — this module never calls Date. */
  preparedOn: string;
  /** Adds a DRAFT watermark; used when previewing an unissued estimate. */
  draft?: boolean;
}

// Nava Wilson red.
const BRAND = rgb(0xce / 255, 0x20 / 255, 0x28 / 255);
const INK = rgb(0.1, 0.1, 0.11);
const SUB = rgb(0.42, 0.45, 0.5);
const HAIR = rgb(0.88, 0.89, 0.91);
const WHITE = rgb(1, 1, 1);

// US Letter, in points.
const PAGE_W = 612;
const PAGE_H = 792;
const M = 46;
const CONTENT_W = PAGE_W - M * 2;

function text(v: unknown, fallback = ""): string {
  const s = v === null || v === undefined ? "" : String(v);
  return s.trim() || fallback;
}

/** "$21,363.69" / "-$4,000.00" — matches formatCurrency's output. */
function money(n: number): string {
  const neg = n < 0;
  const abs = Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${abs}`;
}

/**
 * Break `value` into lines that fit `maxWidth`. pdf-lib has no wrapping, and an
 * overlong firm address or disclaimer would otherwise run off the page.
 */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else {
      if (line) out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

function drawRight(
  page: PDFPage,
  value: string,
  rightX: number,
  y: number,
  font: PDFFont,
  size: number,
  color = INK,
) {
  const w = font.widthOfTextAtSize(value, size);
  page.drawText(value, { x: rightX - w, y, size, font, color });
}

export async function generateClosingCostPdf(
  params: ClosingCostPdfParams,
): Promise<Uint8Array> {
  const { statement, config, fileNo, propertyAddress, clientName, preparedOn, draft } =
    params;

  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  doc.setTitle("Estimated Closing Costs — Residential Purchase (Ontario)");
  doc.setSubject("Purchase closing cost estimate");
  doc.setCreator(text(config.firm_name, "Nava Wilson Professional Corporation"));

  const rightEdge = PAGE_W - M;

  // ── Letterhead band ──
  const bandH = 68;
  page.drawRectangle({
    x: 0,
    y: PAGE_H - bandH,
    width: PAGE_W,
    height: bandH,
    color: BRAND,
  });

  let y = PAGE_H - 24;
  page.drawText(text(config.firm_name, "NAVA WILSON PROFESSIONAL CORPORATION"), {
    x: M,
    y,
    size: 12.5,
    font: bold,
    color: WHITE,
  });
  y -= 13;
  page.drawText(text(config.firm_subtitle, "Barristers and Solicitors"), {
    x: M,
    y,
    size: 7.5,
    font: regular,
    color: WHITE,
  });
  y -= 11;
  page.drawText(text(config.firm_address), {
    x: M,
    y,
    size: 7.5,
    font: regular,
    color: WHITE,
  });

  // Contact block, right-aligned inside the band.
  const phone = text(config.firm_phone);
  const fax = text(config.firm_fax);
  const contact = [phone && `Tel: ${phone}`, fax && `Fax: ${fax}`]
    .filter(Boolean)
    .join("  ·  ");
  drawRight(page, contact, rightEdge, PAGE_H - 24, regular, 7.5, WHITE);
  drawRight(
    page,
    `HST # ${text(config.firm_hst_number)}`,
    rightEdge,
    PAGE_H - 35,
    regular,
    7.5,
    WHITE,
  );
  if (fileNo) {
    drawRight(page, `File No.: ${fileNo}`, rightEdge, PAGE_H - 46, bold, 7.5, WHITE);
  }

  // ── Title ──
  y = PAGE_H - bandH - 26;
  page.drawText("ESTIMATED CLOSING COSTS — RESIDENTIAL PURCHASE (ONTARIO)", {
    x: M,
    y,
    size: 10.5,
    font: bold,
    color: BRAND,
  });

  y -= 13;
  const meta = [
    clientName ? `Prepared for ${clientName}` : null,
    propertyAddress || null,
    `Prepared ${preparedOn}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  for (const line of wrap(meta, regular, 7.5, CONTENT_W)) {
    page.drawText(line, { x: M, y, size: 7.5, font: regular, color: SUB });
    y -= 10;
  }

  // ── Cost groups ──
  y -= 6;
  const amountX = rightEdge;

  for (const group of statement.groups) {
    if (group.lines.length === 0) continue;

    y -= 8;
    page.drawText(group.title.toUpperCase(), {
      x: M,
      y,
      size: 7.5,
      font: bold,
      color: BRAND,
    });
    y -= 4;
    page.drawLine({
      start: { x: M, y },
      end: { x: rightEdge, y },
      thickness: 0.5,
      color: HAIR,
    });
    y -= 12;

    for (const line of group.lines) {
      page.drawText(line.label, { x: M, y, size: 9, font: regular, color: INK });

      // The ESTIMATE badge is what tells the client the title premium is not yet
      // the real FCT quote, so it has to survive into the PDF.
      if (line.badge) {
        const labelW = regular.widthOfTextAtSize(line.label, 9);
        page.drawText(line.badge, {
          x: M + labelW + 8,
          y: y + 0.5,
          size: 6,
          font: bold,
          color: BRAND,
        });
      }

      drawRight(page, money(line.amount), amountX, y, regular, 9);
      y -= 11;

      if (line.sublabel) {
        page.drawText(line.sublabel, { x: M, y, size: 7, font: italic, color: SUB });
        y -= 10;
      }
    }
  }

  // ── HST ──
  y -= 4;
  page.drawLine({
    start: { x: M, y },
    end: { x: rightEdge, y },
    thickness: 0.5,
    color: HAIR,
  });
  y -= 13;
  page.drawText(statement.hst.label, { x: M, y, size: 9, font: regular, color: INK });
  drawRight(page, money(statement.hst.amount), amountX, y, regular, 9);

  // ── Total bar ──
  y -= 26;
  const totalH = 24;
  page.drawRectangle({
    x: M,
    y: y - 6,
    width: CONTENT_W,
    height: totalH,
    color: BRAND,
  });
  page.drawText("Total Closing Costs (fees, taxes & disbursements)", {
    x: M + 10,
    y: y + 1,
    size: 9,
    font: bold,
    color: WHITE,
  });
  drawRight(page, money(statement.total), amountX - 10, y + 1, bold, 11, WHITE);

  // ── Balance due block ──
  y -= 26;
  const b = statement.balance;
  const balanceRows: Array<[string, number, boolean]> = [
    ["Purchase price", b.purchasePrice, false],
    ["less deposit paid", -b.depositPaid, false],
    ["less mortgage advance", -b.mortgageAmount, false],
    ["plus closing costs (above)", b.closingCosts, false],
    ["Estimated Balance Due on Closing (from client)", b.balanceDue, true],
  ];
  const blockH = 18 + balanceRows.length * 13 + 6;
  page.drawRectangle({
    x: M,
    y: y - blockH + 12,
    width: CONTENT_W,
    height: blockH,
    borderColor: BRAND,
    borderWidth: 0.7,
    borderDashArray: [3, 2],
  });

  let by = y;
  page.drawText("FUNDS YOU'LL NEED ON CLOSING", {
    x: M + 10,
    y: by,
    size: 6.5,
    font: bold,
    color: BRAND,
  });
  by -= 13;

  for (const [label, amount, emphasis] of balanceRows) {
    if (emphasis) {
      by -= 3;
      page.drawLine({
        start: { x: M + 10, y: by + 9 },
        end: { x: rightEdge - 10, y: by + 9 },
        thickness: 0.5,
        color: HAIR,
      });
      page.drawText(label, { x: M + 10, y: by, size: 9, font: bold, color: BRAND });
      drawRight(page, money(amount), amountX - 10, by, bold, 12, BRAND);
    } else {
      page.drawText(label, { x: M + 10, y: by, size: 8.5, font: regular, color: SUB });
      drawRight(page, money(amount), amountX - 10, by, regular, 8.5, SUB);
    }
    by -= 13;
  }

  // ── Disclaimers ──
  y = by - 14;
  page.drawText("This is an estimate for planning purposes only.", {
    x: M,
    y,
    size: 7,
    font: bold,
    color: INK,
  });
  y -= 10;
  for (const item of DISCLAIMERS.slice(1)) {
    for (const line of wrap(item, regular, 6.5, CONTENT_W)) {
      page.drawText(line, { x: M, y, size: 6.5, font: regular, color: SUB });
      y -= 8;
    }
  }

  // ── DRAFT watermark ──
  // Only on an unissued preview, so a working copy can never be mistaken for the
  // statement actually sent to the client.
  if (draft) {
    const label = "DRAFT";
    const size = 96;
    const w = bold.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (PAGE_W - w) / 2,
      y: PAGE_H / 2 - 40,
      size,
      font: bold,
      color: BRAND,
      opacity: 0.08,
      rotate: degrees(30),
    });
  }

  return doc.save();
}

/** "estimated-closing-costs-26P-1234.pdf" */
export function closingCostPdfFileName(fileNo?: string | null): string {
  const suffix = (fileNo ?? "").trim().replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-|-$/g, "");
  return suffix
    ? `estimated-closing-costs-${suffix}.pdf`
    : "estimated-closing-costs.pdf";
}
