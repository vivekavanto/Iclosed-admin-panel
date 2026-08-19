// Layout for the two MERGED PDFs the conveyancing clerks asked for: every
// party's identification in one document, every party's personal information in
// another.
//
// Pure rendering — no database, no blob store, no logger. Everything it needs
// arrives as arguments (`fetchBytes` included), which is what lets
// tests/clerkCombinedPdf.test.ts drive it with synthetic data. The queries that
// assemble that data live in clerkCombinedDocs.ts, and the deal page's
// browser-side equivalent is dealPdf.ts's buildCombinedPdfBytes.
//
// Built with pdf-lib rather than the jsPDF path in dealPdf.ts for the same
// reason closingCostPdf.ts is: this runs in a route handler, where there is no
// DOM. That costs two things the browser export has, and both degrade rather
// than fail:
//
//   • HEIC IDs can't be converted here (the decoder is WASM-in-the-browser), and
//   • pdf-lib decodes only baseline JPEG and PNG.
//
// A document it can't embed is left OUT of the merged PDF and reported in
// `skipped`, so the caller can keep sending it as its own attachment. A clerk
// never loses a document; at worst one arrives separately.
//
// Explicit `.ts` extensions on any local import: this module is reachable from
// the node --test loader, which will not resolve an extensionless specifier.
// (There are none today — keep it that way if you can.)

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/** One party on the file. Callers pass these in family order, primary first. */
export interface ClerkPerson {
  leadId: string;
  name: string;
}

/** An identification document belonging to one party. */
export interface ClerkIdDoc {
  leadId: string;
  fileUrl: string;
  fileName: string;
  /** "Driver's Licence" / "Passport" — captioned onto the page. */
  label: string;
}

/** One answer on the personal-information form. */
export interface ClerkInfoRow {
  label: string;
  value: string;
}

/** Pulls a stored document's bytes. Injected so the layout stays testable. */
export type FetchDocBytes = (fileUrl: string) => Promise<Uint8Array>;

export interface IdentificationPdfResult {
  bytes: Uint8Array;
  /** Documents merged in. */
  count: number;
  /** Blob URLs that made it in — the caller excludes these from its attachments. */
  consumedUrls: string[];
  /** "<file name>: <reason>" per document left out, for the caller's log. */
  skipped: string[];
}

// ───────────────────────────── page furniture ─────────────────────────────

const A4 = { w: 595.28, h: 841.89 };
const M = 48;
const CONTENT_W = A4.w - M * 2;
const TOP = A4.h - 96;
const BOTTOM = 72;

const BRAND = rgb(193 / 255, 0, 7 / 255);
const INK = rgb(24 / 255, 24 / 255, 27 / 255);
const SUB = rgb(107 / 255, 114 / 255, 128 / 255);
const HAIR = rgb(226 / 255, 232 / 255, 240 / 255);

/**
 * pdf-lib's standard fonts encode WinAnsi only, and drawText THROWS on anything
 * outside it — an em dash pasted into an address would otherwise fail the whole
 * send. Map the typography we actually produce down to ASCII and replace the
 * rest rather than losing the document.
 */
export function winAnsiSafe(value: unknown): string {
  return String(value ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    // What is left is the printable ASCII and Latin-1 range WinAnsi covers.
    .replace(/[^\x20-\x7E¡-ÿ]/g, "?");
}

/** Break text into lines that fit `maxWidth`; pdf-lib does no wrapping itself. */
function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = winAnsiSafe(value).split(/\s+/).filter(Boolean);
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

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/** Running header: which file this page belongs to, and a rule under it. */
function stampHeader(page: PDFPage, fonts: Fonts, fileNumber: string, section: string) {
  page.drawText(winAnsiSafe(`${section.toUpperCase()}  ·  FILE ${fileNumber || "-"}`), {
    x: M,
    y: A4.h - 56,
    size: 8,
    font: fonts.bold,
    color: SUB,
  });
  const mark = "iClosed";
  page.drawText(mark, {
    x: A4.w - M - fonts.bold.widthOfTextAtSize(mark, 11),
    y: A4.h - 58,
    size: 11,
    font: fonts.bold,
    color: INK,
  });
  page.drawLine({
    start: { x: M, y: A4.h - 68 },
    end: { x: A4.w - M, y: A4.h - 68 },
    thickness: 1.2,
    color: BRAND,
  });
  page.drawText("CONFIDENTIAL", { x: M, y: 40, size: 7.5, font: fonts.bold, color: BRAND });
}

/** A heading band: the party's name, with an optional label above it. Returns the
 *  y the content below it starts at. */
function drawHeading(
  page: PDFPage,
  fonts: Fonts,
  y: number,
  title: string,
  label?: string,
): number {
  let cursor = y;
  if (label) {
    page.drawText(winAnsiSafe(label.toUpperCase()), {
      x: M,
      y: cursor,
      size: 8,
      font: fonts.bold,
      color: BRAND,
    });
    cursor -= 18;
  }
  page.drawText(winAnsiSafe(title), { x: M, y: cursor, size: 17, font: fonts.bold, color: INK });
  cursor -= 12;
  page.drawLine({
    start: { x: M, y: cursor },
    end: { x: A4.w - M, y: cursor },
    thickness: 1,
    color: HAIR,
  });
  return cursor - 22;
}

// ─────────────────────────── document type sniffing ───────────────────────────

export type ClerkDocKind = "pdf" | "jpg" | "png" | "other";

/**
 * What this blob actually is. The stored file name is a hint, not a guarantee
 * (uploads arrive named "1759923628_1759" often enough), so the magic bytes win.
 */
export function detectDocKind(bytes: Uint8Array, fileName?: string | null): ClerkDocKind {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf";
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  }
  const n = String(fileName ?? "").toLowerCase().split(/[?#]/)[0];
  if (n.endsWith(".pdf")) return "pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "jpg";
  if (n.endsWith(".png")) return "png";
  return "other";
}

// ────────────────────────────── the two renderers ──────────────────────────────

/**
 * Every party's identification in one document.
 *
 * On a family file each party's run of documents opens with a page carrying
 * their name: an uploaded PDF's pages are copied in verbatim and so can't be
 * captioned, and without the divider a scanned passport would sit in the merged
 * document with nothing saying whose it is.
 *
 * Returns null when nothing could be merged, so the caller omits the attachment
 * rather than sending an empty PDF.
 */
export async function renderIdentificationPdf(params: {
  people: ClerkPerson[];
  docsByLead: Map<string, ClerkIdDoc[]>;
  fileNumber: string;
  fetchBytes: FetchDocBytes;
}): Promise<IdentificationPdfResult | null> {
  const { people, docsByLead, fileNumber, fetchBytes } = params;

  const out = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
  };
  const withDocs = people.filter((p) => (docsByLead.get(p.leadId) ?? []).length > 0);
  const consumedUrls: string[] = [];
  const skipped: string[] = [];
  let count = 0;

  for (const person of withDocs) {
    if (withDocs.length > 1) {
      const page = out.addPage([A4.w, A4.h]);
      stampHeader(page, fonts, fileNumber, "Identification");
      drawHeading(page, fonts, TOP, person.name || "Client", "Identification");
    }

    for (const doc of docsByLead.get(person.leadId) ?? []) {
      let bytes: Uint8Array;
      try {
        bytes = await fetchBytes(doc.fileUrl);
      } catch (err) {
        // Left out of the merge and NOT reported as consumed, so it still goes
        // out as its own attachment (or, failing that, as a link).
        skipped.push(`${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const kind = detectDocKind(bytes, doc.fileName);
      try {
        if (kind === "pdf") {
          const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
          const pages = await out.copyPages(src, src.getPageIndices());
          for (const p of pages) out.addPage(p);
        } else if (kind === "jpg" || kind === "png") {
          const img = kind === "jpg" ? await out.embedJpg(bytes) : await out.embedPng(bytes);
          const page = out.addPage([A4.w, A4.h]);
          stampHeader(page, fonts, fileNumber, "Identification");
          const top = drawHeading(
            page,
            fonts,
            TOP,
            person.name || "Client",
            doc.label || "Identification",
          );
          const scale = Math.min(CONTENT_W / img.width, (top - BOTTOM) / img.height, 1);
          const w = img.width * scale;
          const h = img.height * scale;
          page.drawImage(img, { x: (A4.w - w) / 2, y: top - h, width: w, height: h });
        } else {
          // HEIC, TIFF, an office document — nothing pdf-lib can place.
          skipped.push(`${doc.fileName}: cannot be embedded server-side`);
          continue;
        }
      } catch (err) {
        skipped.push(`${doc.fileName}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      consumedUrls.push(doc.fileUrl);
      count++;
    }
  }

  if (count === 0) return null;
  return { bytes: await out.save(), count, consumedUrls, skipped };
}

/**
 * Every party's personal-information answers in one document, each starting on
 * their own page and flowing onto further ones when the form is long.
 *
 * Returns null when no party has any answers.
 */
export async function renderPersonalInfoPdf(params: {
  people: ClerkPerson[];
  rowsByLead: Map<string, ClerkInfoRow[]>;
  fileNumber: string;
}): Promise<{ bytes: Uint8Array; count: number } | null> {
  const { people, rowsByLead, fileNumber } = params;

  const withRows = people.filter((p) => (rowsByLead.get(p.leadId) ?? []).length > 0);
  if (withRows.length === 0) return null;

  const out = await PDFDocument.create();
  const fonts: Fonts = {
    regular: await out.embedFont(StandardFonts.Helvetica),
    bold: await out.embedFont(StandardFonts.HelveticaBold),
  };

  const SIZE = 10;
  const LINE = SIZE * 1.35;
  const LABEL_W = 170;
  const VALUE_W = CONTENT_W - LABEL_W - 12;

  for (const person of withRows) {
    let page = out.addPage([A4.w, A4.h]);
    stampHeader(page, fonts, fileNumber, "Personal Information");
    let y = drawHeading(page, fonts, TOP, person.name || "Client", "Personal Information");

    for (const row of rowsByLead.get(person.leadId) ?? []) {
      const labelLines = wrap(row.label, fonts.bold, SIZE, LABEL_W);
      const valueLines = wrap(row.value, fonts.regular, SIZE, VALUE_W);
      const height = Math.max(labelLines.length, valueLines.length) * LINE + 12;

      if (y - height < BOTTOM) {
        page = out.addPage([A4.w, A4.h]);
        stampHeader(page, fonts, fileNumber, "Personal Information");
        y = drawHeading(
          page,
          fonts,
          TOP,
          person.name || "Client",
          "Personal Information (cont.)",
        );
      }

      let ly = y;
      for (const line of labelLines) {
        page.drawText(line, { x: M, y: ly, size: SIZE, font: fonts.bold, color: SUB });
        ly -= LINE;
      }
      let vy = y;
      for (const line of valueLines) {
        page.drawText(line, {
          x: M + LABEL_W + 12,
          y: vy,
          size: SIZE,
          font: fonts.regular,
          color: INK,
        });
        vy -= LINE;
      }

      y -= height;
      page.drawLine({
        start: { x: M, y: y + 6 },
        end: { x: A4.w - M, y: y + 6 },
        thickness: 0.5,
        color: HAIR,
      });
    }
  }

  return { bytes: await out.save(), count: withRows.length };
}
