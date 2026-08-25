// The deal package's LOOK, rendered server-side.
//
// "Download All" and "Email to Clerk" used to be two separate PDF builders —
// jsPDF in the browser for the ZIP, pdf-lib on the server for the clerk email.
// They enumerated documents differently and drew personal information
// differently, so one file produced two different packages: a document present
// in one was missing from the other, and the clerk's copy didn't match the
// format staff saw on screen. This module is the single renderer both now go
// through (dealPackage.ts is the single enumeration).
//
// The visual language is the one the browser export established and the clerks
// already read — a cover page, a red-barred grey band per section, grey-label /
// bold-value key rows with hairlines, and running "DEAL FILE" / "CONFIDENTIAL"
// chrome — reproduced here in pdf-lib.
//
// Chrome is stamped ONLY on pages we drew. Pages copied out of an uploaded
// document are left exactly as they arrived: a client's mortgage commitment must
// not come back with our header printed over its own.
//
// Deliberately DEPENDENCY-FREE (pdf-lib only — no Supabase, no blob store, no
// logger): everything it needs arrives as arguments, which is what lets
// tests/packagePdf.test.ts drive it with synthetic documents. The queries that
// feed it live in dealPackage.ts. Keep it that way — an extensionless local
// import would put it out of reach of the node --test loader.
//
// It runs in a route handler, where there is no DOM. That costs two things the
// old browser export had, and both degrade rather than fail: HEIC can't be
// converted (the decoder is WASM-in-the-browser) and pdf-lib decodes only
// baseline JPEG and PNG. Whatever can't be embedded is reported in `skipped` so
// the caller ships the original instead.

import {
  PDFDocument,
  StandardFonts,
  rgb,
  decodePDFRawStream,
  PDFName,
  PDFArray,
  type PDFFont,
  type PDFPage,
  type PDFImage,
  type RGB,
} from "pdf-lib";

// A4 in points, matching the browser export's `new jsPDF({ unit: "pt", format: "a4" })`.
export const A4 = { w: 595.28, h: 841.89 };
export const M = 64; // side margin
export const CONTENT_W = A4.w - M * 2;
export const TOP = A4.h - 104; // content top, clearing the running header
export const BOTTOM = 76; // content bottom, clearing the running footer

// Palette lifted from PKG in dealPdf.ts so the two exports are the same document.
const BRAND = rgb(193 / 255, 0, 7 / 255);
const INK = rgb(24 / 255, 24 / 255, 27 / 255);
const SUB = rgb(107 / 255, 114 / 255, 128 / 255);
const FAINT = rgb(148 / 255, 156 / 255, 168 / 255);
const HAIR = rgb(224 / 255, 228 / 255, 234 / 255);
const PANEL = rgb(246 / 255, 247 / 255, 249 / 255);
const TITLE_INK = rgb(28 / 255, 28 / 255, 32 / 255);

/** Row metrics — the browser export's defaults. */
const SIZE = 10.5;
const LINE = SIZE * 1.35;
const PAD_TOP = 12;
const PAD_BOT = 12;
const LABEL_W = 180;

/**
 * How far an image may be blown up to fill the column.
 *
 * Real IDs are photos or scans well over 1000px wide, so they are scaled DOWN to
 * the column and this never applies. It exists for the small scan — without it a
 * 300px licence sat at its natural size in the middle of a full page of white.
 * Capped rather than uncapped so a thumbnail isn't stretched into a blur.
 */
const MAX_IMAGE_UPSCALE = 2.5;

/** band()'s own height plus the gap it leaves behind it. */
const BAND_BLOCK = 42 + 18;

export type PackageDocKind = "pdf" | "jpg" | "png" | "other";

/**
 * What an uploaded file actually is.
 *
 * Magic bytes first: a client's phone routinely names a PNG ".jpg", and the
 * stored name is only a hint.
 */
export function detectDocKind(bytes: Uint8Array, fileName?: string | null): PackageDocKind {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)
      return "pdf";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return "png";
  }
  const n = String(fileName ?? "").toLowerCase().split(/[?#]/)[0];
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "jpg";
  if (n.endsWith(".png")) return "png";
  return "other";
}

/**
 * pdf-lib's standard fonts encode WinAnsi only, and drawText THROWS on anything
 * outside it — an em dash pasted into an address would otherwise fail the whole
 * document. Map the typography we actually produce down to ASCII and replace the
 * rest rather than losing the page.
 */
export function winAnsiSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    // What is left is the printable ASCII and Latin-1 range WinAnsi covers.
    .replace(/[^\x20-\x7E¡-ÿ]/g, "?");
}

/** The heading the personal-information form's bare address fields sit under. */
export const MAIL_FORWARDING_HEADING = "Mail forwarding address";

export function startsMailForwarding(label: string | null | undefined): boolean {
  return String(label ?? "").trim().toLowerCase() === "street address";
}

export interface PackageDealMeta {
  fileNumber: string;
  type?: string | null;
  status?: string | null;
  propertyAddress?: string | null;
  sellingPropertyAddress?: string | null;
  closingDate?: string | null;
  price?: number | null;
}

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  serif: PDFFont;
  mono: PDFFont;
}

function money(n?: number | null): string | null {
  if (n == null || Number.isNaN(Number(n))) return null;
  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: "CAD",
      maximumFractionDigits: 0,
    }).format(Number(n));
  } catch {
    return `$${Number(n).toLocaleString()}`;
  }
}

/** "Sale of 461 King Street West, Toronto, ON" → title + locality. */
export function splitAddress(addr?: string | null): { title: string; locality: string } {
  const raw = String(addr ?? "")
    .replace(/^\s*(purchase\s*&\s*sale|purchase|sale)\s+of\s+/i, "")
    .trim();
  if (!raw) return { title: "", locality: "" };
  const ci = raw.indexOf(",");
  if (ci === -1) return { title: raw, locality: "" };
  return { title: raw.slice(0, ci).trim(), locality: raw.slice(ci + 1).trim() };
}

/** Greedy word wrap, chopping a word that is itself wider than the column. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const text = winAnsiSafe(value);
  if (!text) return [""];
  const out: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) {
        out.push(line);
        line = "";
      }
      // A single over-wide word is chopped rather than allowed to bleed out of
      // the column — a long blob filename would otherwise run off the page.
      if (font.widthOfTextAtSize(word, size) > maxWidth) {
        let chunk = "";
        for (const ch of word) {
          if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
            out.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

// ───────────────────── what a merge DROPS from an upload ─────────────────────
//
// Two kinds of page:
//
//   • BLANK — the scanner's empty back side. The clerks asked for the
//     identification PDF to be "a simple merge of all uploaded IDs", and a
//     two-sided scan of a one-sided licence contributes a page of nothing.
//   • SCAFFOLD — a page of OUR OWN chrome, which happens when an uploaded
//     document is itself an older iClosed package export: its title cards and
//     "the original is merged below" placeholders would otherwise land here as
//     pages that say nothing.
//
// Every check FAILS OPEN. Any parse problem, any unavailable pdf-lib internal,
// or a source whose pages all look droppable keeps the document whole. Losing a
// page of a client's legal document is far worse than keeping an empty one.

/**
 * Decode a page's content stream to a latin-1 string.
 *
 * Returns null when the stream can't be read — callers must treat that as
 * "keep the page".
 */
export function decodePageContent(src: PDFDocument, page: PDFPage): string | null {
  try {
    const contents = page.node.get(PDFName.of("Contents"));
    const resolved = src.context.lookup(contents);
    const streams: unknown[] =
      resolved instanceof PDFArray
        ? resolved.asArray().map((r) => src.context.lookup(r))
        : [resolved];
    const decoder = new TextDecoder("latin1");
    let out = "";
    for (const s of streams) {
      if (!s) continue;
      out += decoder.decode(decodePDFRawStream(s as never).decode());
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Text-showing operators actually drawn on the page.
 *
 * Counts all four show operators (`Tj`, `TJ`, `'`, `"`) after any of the three
 * string forms a producer may use: a literal `(text)`, a hex `<0044>` — which is
 * what pdf-lib itself writes — or a positioned array `[(a) -20 (b)]`.
 * Undercounting here would let a page of real text be mistaken for a blank one
 * and dropped.
 */
export function textDrawCount(content: string): number {
  return content.match(/(?:\)|>|\])\s*(?:Tj|TJ|'|")/g)?.length ?? 0;
}

/** Any image or form XObject painted on the page. */
export function paintsXObject(content: string): boolean {
  return /\/[A-Za-z0-9_.]+\s+Do\b/.test(content);
}

/**
 * The text a page actually shows, recovered from its string operands.
 *
 * A content stream carries text either literally — `(DEAL FILE)`, which is what
 * the old jsPDF export wrote — or hex-encoded — `<4445414C2046494C45>`, which is
 * what pdf-lib writes and therefore what our own exports look like now. Reading
 * only the literal form would mean a package export uploaded back onto another
 * file was no longer recognised as our own scaffolding.
 *
 * Single-byte encodings only (the standard fonts both producers use). A page set
 * in an embedded CID font decodes to noise here, which costs nothing: it just
 * fails the "is this ours" check and the page is kept.
 */
export function shownText(content: string): string {
  const parts: string[] = [];
  for (const m of content.matchAll(/<([0-9A-Fa-f][0-9A-Fa-f\s]*)>/g)) {
    const hex = m[1].replace(/\s+/g, "");
    let decoded = "";
    for (let i = 0; i + 1 < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    parts.push(decoded);
  }
  for (const m of content.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
    parts.push(m[1].replace(/\\([()\\])/g, "$1"));
  }
  return parts.join(" ");
}

/**
 * A page with nothing on it: no text, no image, no vector mark.
 *
 * Vector marks count — a page holding only a signature line or a stamp box is
 * not blank — so path-painting operators are checked too.
 */
export function isBlankPage(src: PDFDocument, page: PDFPage): boolean {
  const content = decodePageContent(src, page);
  if (content === null) return false; // couldn't read it → keep it
  if (textDrawCount(content) > 0) return false;
  if (paintsXObject(content)) return false;
  // Path painting: fill, stroke, fill+stroke and their even-odd/close variants,
  // matched as whole operators so the "f" inside a name or number never counts.
  if (/(?:^|[\s\]>])(?:f\*?|F|B\*?|b\*?|S|s)(?=[\s\r\n]|$)/m.test(content)) return false;
  // Inline images.
  if (/\bBI\b[\s\S]*?\bEI\b/.test(content)) return false;
  return true;
}

/** A page of our own scaffolding inside an uploaded copy of an older export. */
export function isScaffoldPage(src: PDFDocument, page: PDFPage): boolean {
  const content = decodePageContent(src, page);
  if (!content) return false;
  const text = shownText(content);
  // Not one of ours → never a candidate.
  if (!text.includes("DEAL FILE") || !text.includes("CONFIDENTIAL")) return false;
  if (text.includes("ATTACHED DOCUMENT") || text.includes("ORIGINAL ATTACHMENT")) return true;
  if (paintsXObject(content)) return false;
  // Chrome (4 draws) + heading band (2) = 6; a name-only block adds 2 more. A
  // block carrying even one real answer reaches 10. The threshold sits between.
  return textDrawCount(content) <= 8;
}

/**
 * The pages of `src` worth copying into a package document, in order.
 *
 * Empty only when EVERY page was droppable — the caller decides what to say
 * about a document that reduced to nothing, rather than shipping empty pages.
 */
export function keepablePageIndices(src: PDFDocument): number[] {
  return src.getPageIndices().filter((i) => {
    const page = src.getPage(i);
    return !isBlankPage(src, page) && !isScaffoldPage(src, page);
  });
}

// ───────────────────────────────── the builder ─────────────────────────────────

export interface SkippedDoc {
  fileUrl: string;
  fileName: string;
  reason: string;
}

/**
 * One PDF under construction.
 *
 * Pages we draw are recorded so chrome can be stamped on them at the end; pages
 * copied out of an uploaded document are deliberately left alone.
 */
export class PackageDoc {
  private doc!: PDFDocument;
  private fonts!: Fonts;
  private ownPages = new Set<PDFPage>();
  private page: PDFPage | null = null;
  private y = TOP;
  readonly meta: PackageDealMeta;
  /** Source documents actually merged in. */
  documents = 0;
  /** Blob URLs whose content genuinely reached this PDF. */
  readonly consumedUrls: string[] = [];
  /** Documents that could not be embedded, so the caller can attach the original. */
  readonly skipped: SkippedDoc[] = [];
  /** Non-fatal rendering complaints, for the caller to log. */
  readonly warnings: string[] = [];

  private constructor(meta: PackageDealMeta) {
    this.meta = meta;
  }

  static async create(meta: PackageDealMeta): Promise<PackageDoc> {
    const self = new PackageDoc(meta);
    self.doc = await PDFDocument.create();
    self.fonts = {
      regular: await self.doc.embedFont(StandardFonts.Helvetica),
      bold: await self.doc.embedFont(StandardFonts.HelveticaBold),
      serif: await self.doc.embedFont(StandardFonts.TimesRomanBold),
      mono: await self.doc.embedFont(StandardFonts.CourierBold),
    };
    return self;
  }

  /** Pages in the document so far — drawn and merged alike. */
  get pageCount(): number {
    return this.doc.getPageCount();
  }

  /** Start a fresh page of our own and reset the writing cursor to its top. */
  newPage(): PDFPage {
    const page = this.doc.addPage([A4.w, A4.h]);
    this.ownPages.add(page);
    this.page = page;
    this.y = TOP;
    return page;
  }

  private current(): PDFPage {
    return this.page ?? this.newPage();
  }

  private text(
    page: PDFPage,
    value: string,
    opts: {
      x: number;
      y: number;
      size: number;
      font: PDFFont;
      color: RGB;
      align?: "left" | "right" | "center";
      charSpace?: number;
    },
  ): void {
    const safe = winAnsiSafe(value);
    if (!safe) return;
    const { align = "left", charSpace = 0 } = opts;
    const width =
      opts.font.widthOfTextAtSize(safe, opts.size) + charSpace * Math.max(0, safe.length - 1);
    const x =
      align === "right" ? opts.x - width : align === "center" ? opts.x - width / 2 : opts.x;
    try {
      page.drawText(safe, {
        x,
        y: opts.y,
        size: opts.size,
        font: opts.font,
        color: opts.color,
        ...(charSpace ? { characterSpacing: charSpace } : {}),
      });
    } catch (err) {
      // A glyph pdf-lib refuses costs that one string, never the document. The
      // caller logs `warnings`; this module stays logger-free by design.
      this.warnings.push(`could not draw text: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * A band that is guaranteed to be followed by content on the same page.
   *
   * band() alone breaks only when the BAND doesn't fit, which can leave a
   * section heading stranded at the foot of a page with its first row overleaf.
   * Sections that flow one after another (every party's personal information in
   * one PDF) use this instead.
   */
  section(title: string, label?: string | null): void {
    const firstRow = PAD_TOP + LINE + PAD_BOT;
    if (this.y - BAND_BLOCK - firstRow < BOTTOM) this.newPage();
    this.band(title, label);
  }

  /** Grey band with a red left bar: bold title + optional letter-spaced label. */
  band(title: string, label?: string | null): void {
    const h = 42;
    const gap = 18;
    if (this.y - h - gap < BOTTOM) this.newPage();
    const page = this.current();
    const top = this.y;
    page.drawRectangle({ x: M, y: top - h, width: CONTENT_W, height: h, color: PANEL });
    page.drawRectangle({ x: M, y: top - h, width: 4, height: h, color: BRAND });

    const tx = M + 18;
    const cy = top - h / 2 - 4;
    this.text(page, title, { x: tx, y: cy, size: 13, font: this.fonts.bold, color: INK });
    if (label) {
      const tw = this.fonts.bold.widthOfTextAtSize(winAnsiSafe(title), 13);
      this.text(page, String(label).toUpperCase(), {
        x: tx + tw + 12,
        y: cy,
        size: 8.5,
        font: this.fonts.bold,
        color: FAINT,
        charSpace: 1.4,
      });
    }
    this.y = top - h - gap;
  }

  private rowHeight(label: string, value: string): number {
    const labelLines = wrap(label, this.fonts.regular, SIZE, LABEL_W - 10);
    const valueLines = wrap(value, this.fonts.bold, SIZE, CONTENT_W - LABEL_W);
    return PAD_TOP + Math.max(labelLines.length, valueLines.length, 1) * LINE + PAD_BOT;
  }

  /** Grey label column, bold value column, hairline underneath. */
  kvRow(label: string, value: string, heading?: string | null): void {
    const headH = heading ? PAD_TOP + LINE + PAD_BOT / 2 : 0;
    const h = this.rowHeight(label, value);
    // A heading and the row it introduces break to a new page together.
    if (this.y - headH - h < BOTTOM) this.newPage();
    if (heading) this.subheading(heading);

    const page = this.current();
    const top = this.y;
    const labelLines = wrap(label, this.fonts.regular, SIZE, LABEL_W - 10);
    const valueLines = wrap(value, this.fonts.bold, SIZE, CONTENT_W - LABEL_W);
    const baseY = top - PAD_TOP - LINE * 0.8;

    labelLines.forEach((ln, i) =>
      this.text(page, ln, {
        x: M,
        y: baseY - i * LINE,
        size: SIZE,
        font: this.fonts.regular,
        color: SUB,
      }),
    );
    valueLines.forEach((ln, i) =>
      this.text(page, ln, {
        x: M + LABEL_W,
        y: baseY - i * LINE,
        size: SIZE,
        font: this.fonts.bold,
        color: INK,
      }),
    );

    const bottom = top - h;
    page.drawLine({
      start: { x: M, y: bottom },
      end: { x: M + CONTENT_W, y: bottom },
      thickness: 0.7,
      color: HAIR,
    });
    this.y = bottom;
  }

  subheading(text: string): void {
    const h = PAD_TOP + LINE + PAD_BOT / 2;
    if (this.y - h < BOTTOM) this.newPage();
    const page = this.current();
    this.text(page, text, {
      x: M,
      y: this.y - PAD_TOP - LINE * 0.8,
      size: SIZE,
      font: this.fonts.bold,
      color: INK,
    });
    this.y -= h;
  }

  /** The package's title page. Only ever the first page of a document. */
  cover(): void {
    const page = this.newPage();
    const cx = A4.w / 2;
    const { title, locality } = splitAddress(this.meta.propertyAddress);
    let y = A4.h - 236;

    this.text(page, "DEAL PACKAGE", {
      x: cx,
      y,
      size: 9,
      font: this.fonts.bold,
      color: BRAND,
      align: "center",
      charSpace: 2.4,
    });
    y -= 40;

    const heading = title || `File ${this.meta.fileNumber || "—"}`;
    let ts = 34;
    let lines = wrap(heading, this.fonts.serif, ts, CONTENT_W);
    while (ts > 20 && lines.length > 2) {
      ts -= 2;
      lines = wrap(heading, this.fonts.serif, ts, CONTENT_W);
    }
    for (const ln of lines) {
      this.text(page, ln, {
        x: cx,
        y,
        size: ts,
        font: this.fonts.serif,
        color: TITLE_INK,
        align: "center",
      });
      y -= ts * 1.18;
    }
    y -= 6;

    const sub = [locality, `File ${this.meta.fileNumber || "—"}`].filter(Boolean).join("  ·  ");
    this.text(page, sub, {
      x: cx,
      y,
      size: 11,
      font: this.fonts.regular,
      color: SUB,
      align: "center",
    });
    y -= 20;

    page.drawLine({
      start: { x: cx - 26, y },
      end: { x: cx + 26, y },
      thickness: 1.4,
      color: BRAND,
    });
    y -= 44;

    this.y = y;
    const rows: Array<[string, string | null | undefined]> = [
      ["File Number", this.meta.fileNumber],
      ["Type", this.meta.type],
      ["Status", this.meta.status],
      ["Property Address", this.meta.propertyAddress],
      ["Selling Property Address", this.meta.sellingPropertyAddress],
      ["Closing Date", this.meta.closingDate],
      ["Price", money(this.meta.price)],
    ];
    for (const [label, val] of rows) {
      if (val && String(val).trim()) this.kvRow(label, String(val));
    }
  }

  /** A full-page card holding one uploaded image. */
  imagePage(heading: string, sublabel: string, img: PDFImage): void {
    const pad = 18;
    const gap = 18;
    const maxW = CONTENT_W - pad * 2;
    const maxH = TOP - BOTTOM - BAND_BLOCK - pad * 2;

    // Fill the column, and no more: capped by the page height so a portrait scan
    // still lands on one page, and by MAX_IMAGE_UPSCALE so a small one isn't
    // stretched into a blur.
    const scale = Math.min(maxW / img.width, maxH / img.height, MAX_IMAGE_UPSCALE);
    const w = img.width * scale;
    const h = img.height * scale;
    const cardH = h + pad * 2;

    // Break only when this image genuinely does not fit under what is already on
    // the page — not on principle. Two landscape IDs then share a page instead
    // of taking one each.
    if (this.y - BAND_BLOCK - cardH < BOTTOM) this.newPage();
    this.band(heading || "Document", sublabel || undefined);

    const page = this.current();
    const top = this.y;
    page.drawRectangle({
      x: M,
      y: top - cardH,
      width: CONTENT_W,
      height: cardH,
      color: rgb(1, 1, 1),
      borderColor: HAIR,
      borderWidth: 1,
    });
    page.drawImage(img, {
      x: M + (CONTENT_W - w) / 2,
      y: top - pad - h,
      width: w,
      height: h,
    });
    this.y = top - cardH - gap;
  }

  /** Stand-in page for a document that could not be embedded inline. */
  notePage(
    idx: number,
    total: number,
    sectionTitle: string,
    fileName: string,
    note: string,
  ): void {
    this.newPage();
    this.band(
      sectionTitle || "Attached Document",
      total > 1 ? `Attached Document · ${idx} of ${total}` : "Attached Document",
    );
    const page = this.current();
    let y = this.y - 24;

    const fname = winAnsiSafe(String(fileName || "document"));
    const chipW = Math.min(CONTENT_W, this.fonts.mono.widthOfTextAtSize(fname, 10.5) + 32);
    const chipH = 34;
    page.drawRectangle({ x: M, y: y - chipH, width: chipW, height: chipH, color: PANEL });
    page.drawRectangle({ x: M, y: y - chipH, width: 4, height: chipH, color: BRAND });
    this.text(page, fname, {
      x: M + 16,
      y: y - chipH / 2 - 4,
      size: 10.5,
      font: this.fonts.mono,
      color: INK,
    });
    y -= chipH + 22;

    for (const ln of wrap(String(note ?? ""), this.fonts.regular, 10, CONTENT_W)) {
      this.text(page, ln, { x: M, y, size: 10, font: this.fonts.regular, color: SUB });
      y -= 15;
    }
    this.y = y;
  }

  /**
   * Embed one uploaded document — an image in the flow (see imagePage), a PDF's
   * own pages copied in verbatim.
   *
   * Returns true when the document's content genuinely reached this PDF, which
   * is what lets the clerk email stop attaching the original separately.
   */
  async addDocument(params: {
    bytes: Uint8Array;
    fileUrl: string;
    fileName: string;
    heading: string;
    sublabel?: string | null;
    index?: number;
    total?: number;
    sectionTitle?: string;
  }): Promise<boolean> {
    const { bytes, fileUrl, fileName, heading, sublabel = "", index = 1, total = 1 } = params;
    const section = params.sectionTitle || heading;
    const kind: PackageDocKind = detectDocKind(bytes, fileName);

    if (kind === "pdf") {
      try {
        const merged = await this.mergePdf(bytes);
        if (merged === 0) {
          // Every page was blank or our own scaffolding. The document exists, so
          // say so rather than silently dropping it.
          this.notePage(
            index,
            total,
            section,
            fileName,
            "This document contained no printable pages.",
          );
          this.consumedUrls.push(fileUrl);
          return true;
        }
        this.documents++;
        this.consumedUrls.push(fileUrl);
        return true;
      } catch (err) {
        this.skipped.push({
          fileUrl,
          fileName,
          reason: err instanceof Error ? err.message : String(err),
        });
        this.notePage(
          index,
          total,
          section,
          fileName,
          "This document could not be merged. It is attached in its original form.",
        );
        return false;
      }
    }

    if (kind === "jpg" || kind === "png") {
      try {
        const img =
          kind === "jpg" ? await this.doc.embedJpg(bytes) : await this.doc.embedPng(bytes);
        this.imagePage(heading, String(sublabel ?? ""), img);
        this.documents++;
        this.consumedUrls.push(fileUrl);
        return true;
      } catch (err) {
        this.skipped.push({
          fileUrl,
          fileName,
          reason: err instanceof Error ? err.message : String(err),
        });
        this.notePage(
          index,
          total,
          section,
          fileName,
          "This image could not be rendered. It is attached in its original form.",
        );
        return false;
      }
    }

    // HEIC, TIFF, an office document — nothing pdf-lib can place.
    this.skipped.push({ fileUrl, fileName, reason: `cannot be embedded server-side (${kind})` });
    this.notePage(
      index,
      total,
      section,
      fileName,
      "This file type cannot be displayed inline. It is attached in its original form.",
    );
    return false;
  }

  /**
   * Copy an uploaded PDF's pages in, dropping blank pages and any page that is
   * another iClosed package's scaffolding. Returns how many pages were kept.
   */
  async mergePdf(bytes: Uint8Array): Promise<number> {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const keep = keepablePageIndices(src);
    if (keep.length === 0) return 0;
    const copied = await this.doc.copyPages(src, keep);
    for (const p of copied) this.doc.addPage(p);
    // A merged page is never the writing cursor — whatever we draw next starts
    // its own page.
    this.page = null;
    return copied.length;
  }

  /** Running header + footer, on our own pages only. */
  private stampChrome(): void {
    const fileNum = this.meta.fileNumber || "—";
    const { title } = splitAddress(this.meta.propertyAddress);
    const footRight = [title.toUpperCase(), fileNum].filter(Boolean).join("  ·  ");

    for (const page of this.doc.getPages()) {
      if (!this.ownPages.has(page)) continue;
      this.text(page, `DEAL FILE · ${fileNum}`, {
        x: M,
        y: A4.h - 56,
        size: 8,
        font: this.fonts.bold,
        color: FAINT,
        charSpace: 1.4,
      });
      this.text(page, "iClosed", {
        x: A4.w - M,
        y: A4.h - 56,
        size: 12,
        font: this.fonts.bold,
        color: INK,
        align: "right",
      });
      page.drawLine({
        start: { x: M, y: A4.h - 68 },
        end: { x: A4.w - M, y: A4.h - 68 },
        thickness: 1.2,
        color: BRAND,
      });
      this.text(page, "CONFIDENTIAL", {
        x: M,
        y: 40,
        size: 7.5,
        font: this.fonts.bold,
        color: BRAND,
        charSpace: 1.4,
      });
      if (footRight) {
        this.text(page, footRight, {
          x: A4.w - M,
          y: 40,
          size: 7.5,
          font: this.fonts.bold,
          color: FAINT,
          align: "right",
          charSpace: 1.2,
        });
      }
    }
  }

  /** Stamp the chrome and serialise. Returns null when nothing was drawn. */
  async save(): Promise<Uint8Array | null> {
    if (this.doc.getPageCount() === 0) return null;
    this.stampChrome();
    return await this.doc.save();
  }
}
