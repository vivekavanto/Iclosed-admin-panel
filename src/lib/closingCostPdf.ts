// Server-side one-page "Statement of Account" PDF.
//
// Built with pdf-lib (already a dependency) rather than the jsPDF path in
// dealPdf.ts, because this runs in a route handler: the bytes are uploaded to
// Vercel Blob once at issue time so the admin panel and the customer portal
// serve the byte-identical artifact. dealPdf.ts is deliberately left untouched —
// it is on the existing task/deal download path.
//
// Everything on the letterhead comes from `closing_cost_config`, so the firm's
// address / phone / HST number can be corrected from the settings page without a
// deploy, and each firm prints in its own `brand_color`.
//
// The layout is deliberately typographic — a centred wordmark, hairline rules
// and colour used only on headings and amounts. An earlier version printed
// solid colour bands behind the letterhead and the total; those made the page
// read as marketing rather than as a statement of account.
//
// ⚠️ Kept byte-identical to the customer portal's copy at
//    d:\iclosed_dev_web\src\lib\closingCostPdf.ts
// so the client downloads the same document whichever app produced it.

import {
  PDFDocument,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
// Explicit `.ts` extensions: this module is reachable from the node --test
// loader, which will not resolve an extensionless specifier. Same reason
// closingCostConfig.ts and closingEstimate.ts write them.
import { BALANCE_LABELS, DISCLAIMERS, type Statement } from "./closingCosts.ts";
import { hexToRgb01, type StatementTypeConfig } from "./closingCostSettings.ts";
import { blobTokenForUrl, isPrivateBlobUrl } from "./blobPrivacy.ts";

export interface ClosingCostPdfParams {
  statement: Statement;
  /** The merged config row supplying the letterhead and the brand colour. */
  config: Record<string, unknown>;
  fileNo?: string | null;
  propertyAddress?: string | null;
  /** Purchaser(s) — printed at the head of the statement. */
  clientName?: string | null;
  /** Already formatted for display; this module never calls Date. */
  closingDate?: string | null;
  /** Stamped in the header. Pass an ISO string — this module never calls Date. */
  preparedOn: string;
  /** Adds a DRAFT watermark; used when previewing an unissued estimate. */
  draft?: boolean;
  /**
   * Title, disclaimer lead line and watermark for this flavour of statement.
   *
   * Omit it and the PDF prints the draft wording with the watermark driven by
   * `draft`, which is what it did before statement types existed.
   */
  statementType?: StatementTypeConfig | null;
  /**
   * The configuration stamp — `v5.9f3a2c1b` — printed in the footer beside the
   * date so a document can be traced back to the exact rates and presentation
   * that produced it. Omitted when the estimate predates snapshots.
   */
  configVersion?: string | null;
}

// The red Nava Wilson statements have always been printed in — now only the
// fallback, since each firm carries its own `brand_color`.
const NAVA_RED = { r: 0xce / 255, g: 0x20 / 255, b: 0x28 / 255 };
const INK = rgb(0.1, 0.1, 0.11);
const SUB = rgb(0.42, 0.45, 0.5);
const HAIR = rgb(0.88, 0.89, 0.91);

// The ESTIMATE chip. Deliberately NOT the firm's colour — it marks a figure as
// provisional, which is a caution, and it must not compete with the brand.
const BADGE_INK = rgb(0x8a / 255, 0x73 / 255, 0x28 / 255);
const BADGE_BG = rgb(0xfb / 255, 0xf3 / 255, 0xd6 / 255);
const BADGE_LINE = rgb(0xe8 / 255, 0xdc / 255, 0xae / 255);

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

function drawCentered(
  page: PDFPage,
  value: string,
  y: number,
  font: PDFFont,
  size: number,
  color = INK,
) {
  const w = font.widthOfTextAtSize(value, size);
  page.drawText(value, { x: (PAGE_W - w) / 2, y, size, font, color });
}

/** The letterhead logo box. Wide enough for a wordmark, short enough to stay a header. */
const LOGO_MAX_W = 210;
const LOGO_MAX_H = 44;

/**
 * Fetch and embed the firm's logo.
 *
 * Returns null on ANY failure — unreachable URL, non-image bytes, a format
 * pdf-lib cannot decode. The caller then prints the firm-name wordmark instead,
 * so a broken logo costs a nicer letterhead but never a blank one or a failed
 * statement.
 *
 * pdf-lib embeds PNG and JPEG only. The upload route enforces that, but a URL
 * edited directly in the database would not go through it, hence the try/catch
 * around the decode as well as the fetch.
 */
async function embedLogo(
  doc: PDFDocument,
  url: unknown,
): Promise<{ image: PDFImage; width: number; height: number } | null> {
  const src = typeof url === "string" ? url.trim() : "";
  if (!src || !/^https?:\/\//i.test(src)) return null;

  try {
    // Logos are uploaded to the PUBLIC store, so normally no auth is needed.
    // A logo stored before that was settled lives in the private store and 401s
    // on a bare fetch, which would silently drop it from the letterhead — so
    // send the store's token when the URL says it is private.
    const res = await fetch(src, {
      cache: "no-store",
      headers: isPrivateBlobUrl(src)
        ? { Authorization: `Bearer ${blobTokenForUrl(src)}` }
        : undefined,
    });
    if (!res.ok) return null;

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;

    // Sniff the magic bytes rather than trusting the URL extension or the
    // Content-Type header, either of which can lie.
    const isPng =
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    if (!isPng && !isJpg) return null;

    const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

    // Contain within the box, preserving the aspect ratio — never upscale, so a
    // small logo stays crisp instead of being blown up and blurry.
    const scale = Math.min(LOGO_MAX_W / image.width, LOGO_MAX_H / image.height, 1);
    return { image, width: image.width * scale, height: image.height * scale };
  } catch {
    return null;
  }
}

export async function generateClosingCostPdf(
  params: ClosingCostPdfParams,
): Promise<Uint8Array> {
  const {
    statement,
    config,
    fileNo,
    propertyAddress,
    clientName,
    closingDate,
    preparedOn,
    draft,
    statementType,
    configVersion,
  } = params;

  // Per-firm, so an iClosed statement is not printed in Nava Wilson's red.
  const brand = hexToRgb01(config.brand_color, NAVA_RED);
  const BRAND = rgb(brand.r, brand.g, brand.b);

  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const firmName = text(config.firm_name, "NAVA WILSON PROFESSIONAL CORPORATION");
  doc.setTitle(
    text(statementType?.title, "Estimated Closing Costs"),
  );
  doc.setSubject("Purchase closing cost estimate");
  doc.setCreator(firmName);

  const rightEdge = PAGE_W - M;
  const amountX = rightEdge;

  /** Full-width hairline. */
  const rule = (atY: number, color = HAIR, thickness = 0.5) =>
    page.drawLine({
      start: { x: M, y: atY },
      end: { x: rightEdge, y: atY },
      thickness,
      color,
    });

  // ── Letterhead ──
  // The firm's logo stands in for the wordmark. It is only ever a replacement
  // when it actually loads — `embedLogo` returns null on any failure and the
  // typeset name takes over, so the letterhead is never blank.
  const logo = await embedLogo(doc, config.logo_url);

  let y = PAGE_H - 52;
  if (logo) {
    y = PAGE_H - 30 - logo.height;
    page.drawImage(logo.image, {
      x: (PAGE_W - logo.width) / 2,
      y,
      width: logo.width,
      height: logo.height,
    });
  } else {
    drawCentered(page, firmName, y, bold, 15, BRAND);
  }

  const subtitle = text(config.firm_subtitle);
  if (subtitle) {
    y -= 12;
    drawCentered(page, subtitle, y, regular, 8, SUB);
  }

  y -= 13;
  const contact = [
    text(config.firm_address),
    text(config.firm_phone) && `Tel: ${text(config.firm_phone)}`,
    text(config.firm_fax) && `Fax: ${text(config.firm_fax)}`,
    text(config.firm_hst_number) && `HST # ${text(config.firm_hst_number)}`,
  ]
    .filter(Boolean)
    .join("  ·  ");
  for (const line of wrap(contact, regular, 7, CONTENT_W)) {
    drawCentered(page, line, y, regular, 7, SUB);
    y -= 9;
  }

  y -= 6;
  rule(y, HAIR, 0.8);

  // ── Title ──
  // Set small, tracked and underlined rather than large and red: it names the
  // document, and on a statement of account the loudest thing on the page
  // should be the money, not the heading.
  y -= 30;
  const title = text(
    statementType?.title,
    "ESTIMATED CLOSING COSTS",
  );
  const TITLE_SIZE = 8;
  const TRACKING = 1.4;
  for (const line of wrap(title, bold, TITLE_SIZE + TRACKING, CONTENT_W)) {
    const upper = line.toUpperCase();
    // pdf-lib has no letter-spacing, so the glyphs are placed one at a time.
    const width =
      bold.widthOfTextAtSize(upper, TITLE_SIZE) +
      TRACKING * Math.max(0, upper.length - 1);
    let cursor = (PAGE_W - width) / 2;
    for (const ch of upper) {
      page.drawText(ch, { x: cursor, y, size: TITLE_SIZE, font: bold, color: INK });
      cursor += bold.widthOfTextAtSize(ch, TITLE_SIZE) + TRACKING;
    }
    // Underlined to the exact width of the words, the way the template sets it.
    page.drawLine({
      start: { x: (PAGE_W - width) / 2, y: y - 3.5 },
      end: { x: (PAGE_W - width) / 2 + width, y: y - 3.5 },
      thickness: 0.6,
      color: INK,
    });
    y -= 14;
  }

  // ── File details ──
  // A labelled block rather than one run-on line: this is the part a client
  // checks first, so it has to be scannable. Rows with nothing to say are
  // omitted entirely, so an estimate captured before these fields existed still
  // prints tidily.
  y -= 12;
  const detailRows: Array<[string, string]> = (
    [
      ["Purchaser(s)", text(clientName)],
      ["Property", text(propertyAddress)],
      ["Closing date", text(closingDate)],
      ["File No.", text(fileNo)],
      ["Date prepared", text(preparedOn)],
    ] as Array<[string, string]>
  ).filter(([, value]) => Boolean(value));

  // Label quiet, value loud — the client is scanning for their own details, so
  // the answers carry the weight and the field names step back.
  const labelW = 78;
  for (const [label, value] of detailRows) {
    page.drawText(label, { x: M, y, size: 8, font: regular, color: SUB });
    const valueLines = wrap(value, bold, 8, CONTENT_W - labelW);
    for (let i = 0; i < valueLines.length; i++) {
      page.drawText(valueLines[i], {
        x: M + labelW,
        y,
        size: 8,
        font: bold,
        color: INK,
      });
      if (i < valueLines.length - 1) y -= 10;
    }
    y -= 11;
  }

  // ── Rows ──
  /**
   * One label/amount row.
   *
   * Amounts print in INK, not the brand colour: on a statement every figure
   * matters equally, and colouring them all red leaves nothing for the one
   * figure that is the point of the page — the balance due.
   */
  const drawRow = (
    label: string,
    amount: number,
    opts: { sublabel?: string; badge?: string; muted?: boolean } = {},
  ) => {
    page.drawText(label, {
      x: M,
      y,
      size: 8.5,
      font: regular,
      color: opts.muted ? SUB : INK,
    });

    if (opts.badge) {
      // A pale chip rather than coloured text: it has to read as a marker on
      // the line, not as part of what the line says.
      const labelWidth = regular.widthOfTextAtSize(label, 8.5);
      const badgeText = opts.badge.toUpperCase();
      const textW = bold.widthOfTextAtSize(badgeText, 5.5);
      const boxX = M + labelWidth + 6;
      const boxY = y - 1.5;
      const boxW = textW + 6;
      const boxH = 9;
      page.drawRectangle({
        x: boxX,
        y: boxY,
        width: boxW,
        height: boxH,
        color: BADGE_BG,
        borderColor: BADGE_LINE,
        borderWidth: 0.4,
      });
      page.drawText(badgeText, {
        x: boxX + 3,
        y: boxY + 2.6,
        size: 5.5,
        font: bold,
        color: BADGE_INK,
      });
    }

    drawRight(page, money(amount), amountX, y, regular, 8.5, opts.muted ? SUB : INK);
    y -= 11;

    if (opts.sublabel) {
      page.drawText(opts.sublabel, { x: M, y, size: 6.5, font: italic, color: SUB });
      y -= 9;
    }
  };

  const drawSectionHeading = (heading: string) => {
    y -= 8;
    page.drawText(heading.toUpperCase(), {
      x: M,
      y,
      size: 7.5,
      font: bold,
      color: BRAND,
    });
    y -= 4;
    rule(y);
    y -= 12;
  };

  for (const group of statement.groups) {
    if (group.lines.length === 0) continue;
    drawSectionHeading(group.title);
    for (const line of group.lines) {
      drawRow(line.label, line.amount, {
        sublabel: line.sublabel,
        badge: line.badge,
        // Rebates read as reductions, not as charges.
        muted: line.amount < 0,
      });
    }
  }

  // HST closes the fee section it is charged on — but below a rule of its own,
  // because it is a tax ON those fees, not another fee. Printed flush against
  // the last line of "Legal & Admin Fees" it read as one more fee in that list.
  // Dashed, not solid: solid hairlines already mean "new section" here.
  y -= 3;
  page.drawLine({
    start: { x: M, y },
    end: { x: rightEdge, y },
    thickness: 0.5,
    color: HAIR,
    dashArray: [2, 2],
  });
  y -= 12;
  drawRow(statement.hst.label, statement.hst.amount);

  // ── Total ──
  y -= 3;
  rule(y, INK, 0.8);
  y -= 13;
  page.drawText(BALANCE_LABELS.total, {
    x: M,
    y,
    size: 9,
    font: bold,
    color: INK,
  });
  drawRight(page, money(statement.total), amountX, y, bold, 10, INK);
  y -= 5;
  rule(y, INK, 0.8);
  y -= 4;

  // ── Property tax adjustment ──
  // Printed AFTER the total because it is a Statement of Adjustments item, not
  // one of the fees, taxes and disbursements that total covers.
  if (statement.propertyTax) {
    drawSectionHeading("Adjustments");
    drawRow(statement.propertyTax.label, statement.propertyTax.amount, {
      sublabel: statement.propertyTax.sublabel,
      badge: statement.propertyTax.badge,
    });
  }

  // ── Funds required on closing ──
  const b = statement.balance;
  drawSectionHeading("Funds Required on Closing");
  // Only the deductions are greyed. They are money the client has already found
  // or that the lender is bringing, so they read as relief; everything else is
  // money they still have to produce.
  drawRow(BALANCE_LABELS.purchase_price, b.purchasePrice);
  drawRow(BALANCE_LABELS.deposit, -b.depositPaid, { muted: true });
  drawRow(BALANCE_LABELS.mortgage, -b.mortgageAmount, { muted: true });
  // Closing costs before adjustments, matching the order of the statement
  // above: the client has just read the itemised costs and their total, so the
  // total repeats here first and the Statement of Adjustments item — the one
  // figure that is still to be confirmed — follows it.
  drawRow(BALANCE_LABELS.closing_costs, b.closingCosts);
  if (b.propertyTaxAdjustment !== 0) {
    // Signed, so a seller in arrears reads as a credit rather than a charge.
    drawRow(
      b.propertyTaxAdjustment > 0
        ? BALANCE_LABELS.adjustment_charge
        : BALANCE_LABELS.adjustment_credit,
      b.propertyTaxAdjustment,
    );
  }

  // The one figure the whole page exists to give. Its label sits in INK like
  // every other label; the AMOUNT is the only thing on the statement printed in
  // the firm's colour, which is what makes the eye land on it.
  y -= 2;
  rule(y, INK, 0.5);
  y -= 15;
  page.drawText(BALANCE_LABELS.balance_due, {
    x: M,
    y,
    size: 10,
    font: bold,
    color: INK,
  });
  drawRight(page, money(b.balanceDue), amountX, y, bold, 13, BRAND);

  // ── Disclaimers ──
  // The lead line is configurable per statement type and prints in the firm's
  // colour, because it is the sentence that stops a client wiring funds early.
  y -= 16;
  const intro = text(
    statementType?.disclaimer_intro,
    "This is an estimate for planning purposes only.",
  );
  for (const line of wrap(intro, bold, 7, CONTENT_W)) {
    page.drawText(line, { x: M, y, size: 7, font: bold, color: BRAND });
    y -= 9;
  }

  y -= 3;
  // The standing legal text runs as one paragraph rather than a list, so it
  // reads as fine print and never competes with the figures.
  const standing = DISCLAIMERS.slice(1).join(" ");
  for (const line of wrap(standing, regular, 6, CONTENT_W)) {
    page.drawText(line, { x: M, y, size: 6, font: regular, color: SUB });
    y -= 7.5;
  }

  const footerNote = text(statementType?.footer_note);
  if (footerNote) {
    y -= 3;
    for (const line of wrap(footerNote, italic, 6, CONTENT_W)) {
      page.drawText(line, { x: M, y, size: 6, font: italic, color: SUB });
      y -= 7.5;
    }
  }

  // ── Footer ──
  //
  // Left: who prepared it, and the configuration stamp that identifies WHICH
  // version of the rates and letterhead produced it. Two statements carrying
  // the same stamp came from the same configuration; two carrying different
  // stamps did not — which makes "this is the document you were sent" a
  // checkable claim rather than an assurance.
  //
  // Right: what kind of statement this is. It is the last thing on the page, so
  // a printed copy that has been separated from its covering email still says
  // whether it is a draft.
  const stamp = text(configVersion);
  const preparedBy = stamp
    ? `Prepared by ${firmName}  ·  ${stamp}`
    : `Prepared by ${firmName}`;
  page.drawText(preparedBy, {
    x: M,
    y: 30,
    size: 6,
    font: regular,
    color: SUB,
  });

  const kind = text(statementType?.label);
  if (kind) {
    page.drawText(kind, {
      x: PAGE_W - M - regular.widthOfTextAtSize(kind, 6),
      y: 30,
      size: 6,
      font: regular,
      color: SUB,
    });
  }

  // ── DRAFT watermark ──
  // Only on an unissued preview, so a working copy can never be mistaken for the
  // statement actually sent to the client. Once a statement type is supplied it
  // decides instead — a "final account" carries no watermark even as a draft.
  const showWatermark = statementType ? statementType.show_watermark : Boolean(draft);
  if (showWatermark) {
    const label = text(statementType?.watermark_text, "DRAFT");
    const size = 96;
    const w = bold.widthOfTextAtSize(label, size);
    page.drawText(label, {
      x: (PAGE_W - w) / 2,
      y: PAGE_H / 2 - 40,
      size,
      font: bold,
      color: BRAND,
      opacity: 0.07,
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
