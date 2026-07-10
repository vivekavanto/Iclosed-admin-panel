// Client-side PDF generation for deal tasks.
//
// Two entry points:
//   • downloadTaskPdf(deal, task)        → one task's info + responses + its files
//   • downloadDealPdf(deal, sections)    → the whole deal: every milestone, task,
//                                          personal-info response, plus every
//                                          uploaded document embedded inline.
//
// The text report (task info + personal information) is laid out with jsPDF
// because its line-wrapping/page-break handling is simple. The uploaded files
// (client IDs, APS, insurance, etc.) live in blob storage and are merged into
// the same PDF with pdf-lib: images are rendered on their own page, uploaded
// PDFs have their pages copied in. Anything that can't be fetched (CORS / sign-in)
// or embedded falls back to a note page so the document is never silently lossy.
//
// Both heavy libraries are dynamically imported inside the handlers so they stay
// out of the initial page bundle and only load when a download is triggered.

export interface PdfResponse {
  field_label?: string | null;
  field_id?: string | null;
  field_type?: string | null;
  value?: string | null;
  file_name?: string | null;
  file_url?: string | null;
}

export interface PdfTaskInput {
  title: string;
  status?: string | null;
  /** Pre-formatted display strings — the caller formats dates with its own helpers. */
  dueDate?: string | null;
  completedAt?: string | null;
  milestoneTitle?: string | null;
  leadType?: string | null;
  /** Owner's full name for per-person tasks (Personal Information / Upload ID).
   *  When set, it's added to the single-task PDF heading, a "Name" row, and the
   *  file name so each person's export is attributable. Null for shared tasks. */
  ownerName?: string | null;
  responses: PdfResponse[];
}

export interface PdfPerson {
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface PdfDealMeta {
  fileNumber: string;
  type?: string | null;
  status?: string | null;
  propertyAddress?: string | null;
  sellingPropertyAddress?: string | null;
  closingDate?: string | null;
  /** Deal price — rendered on the package cover when present. */
  price?: number | null;
  people?: PdfPerson[];
}

export interface PdfDealSection {
  milestoneTitle: string;
  leadType?: string | null;
  tasks: PdfTaskInput[];
}

// A group of files to embed after the text report, captioned by their origin.
interface EmbedGroup {
  caption: string;
  responses: PdfResponse[];
}

const BRAND: [number, number, number] = [193, 0, 7]; // #C10007

// ─────────────────────────── jsPDF text writer ───────────────────────────

type JsPdfDoc = any;

function makeWriter(doc: JsPdfDoc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const contentW = pageW - margin * 2;
  let y = margin;

  function ensure(space: number) {
    if (y + space > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  }

  function text(
    str: string,
    opts: {
      size?: number;
      bold?: boolean;
      color?: [number, number, number];
      gap?: number;
      indent?: number;
    } = {},
  ) {
    const { size = 10, bold = false, color = [40, 40, 40], gap = 4, indent = 0 } = opts;
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(color[0], color[1], color[2]);
    const lines: string[] = doc.splitTextToSize(str ?? "", contentW - indent);
    const lineH = size * 1.4;
    for (const ln of lines) {
      ensure(lineH);
      doc.text(ln, margin + indent, y);
      y += lineH;
    }
    y += gap;
  }

  // Aligned label/value row: the label sits in a fixed-width left column and the
  // value wraps in the remaining width, so every field on the page lines up.
  function kv(
    label: string,
    value: string,
    opts: { indent?: number; labelW?: number; size?: number; gap?: number } = {},
  ) {
    const { indent = 0, labelW = 168, size = 10, gap = 4 } = opts;
    doc.setFontSize(size);
    const labelX = margin + indent;
    const valueX = labelX + labelW;
    const valueW = pageW - margin - valueX;
    const lineH = size * 1.4;

    doc.setFont("helvetica", "bold");
    const labelLines: string[] = doc.splitTextToSize(label ?? "", labelW - 8);
    doc.setFont("helvetica", "normal");
    const valueLines: string[] = doc.splitTextToSize(value ?? "", valueW);

    const rows = Math.max(labelLines.length, valueLines.length, 1);
    ensure(rows * lineH);
    const startY = y;

    doc.setFont("helvetica", "bold");
    doc.setTextColor(75, 75, 80);
    labelLines.forEach((ln, i) => doc.text(ln, labelX, startY + i * lineH));

    doc.setFont("helvetica", "normal");
    doc.setTextColor(30, 30, 30);
    valueLines.forEach((ln, i) => doc.text(ln, valueX, startY + i * lineH));

    y = startY + rows * lineH + gap;
  }

  function spacer(h: number) {
    y += h;
  }

  async function addImageFromBytes(bytes: Uint8Array, format: "jpg" | "png") {
    try {
      const blob = new Blob([bytes as unknown as BlobPart], { type: format === "jpg" ? "image/jpeg" : "image/png" });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load error"));
        img.src = url;
      });

      const origW = img.naturalWidth;
      const origH = img.naturalHeight;
      const maxW = contentW;
      let remainingH = pageH - margin - y;
      let scale = Math.min(maxW / origW, remainingH / origH, 1);
      if (scale <= 0) {
        doc.addPage();
        y = margin;
        remainingH = pageH - margin - y;
        scale = Math.min(maxW / origW, remainingH / origH, 1);
      }
      const wImg = origW * scale;
      const hImg = origH * scale;
      // jsPDF expects the image element or data URL; pass the element.
      doc.addImage(img, format === "jpg" ? "JPEG" : "PNG", margin, y, wImg, hImg);
      y += hImg + 12;
      URL.revokeObjectURL(url);
    } catch {
      // ignore image errors — caller will fall back to embedding via pdf-lib
    }
  }

  function rule(color: [number, number, number] = [222, 222, 226]) {
    ensure(14);
    doc.setDrawColor(color[0], color[1], color[2]);
    doc.setLineWidth(0.6);
    doc.line(margin, y, pageW - margin, y);
    y += 12;
  }

  return { text, kv, spacer, rule, ensure, addImageFromBytes };
}

function writeTaskSection(
  w: ReturnType<typeof makeWriter>,
  task: PdfTaskInput,
  opts: { showTitle?: boolean } = {},
) {
  const { showTitle = true } = opts;
  if (showTitle) {
    w.text(task.title || "Untitled task", { size: 13, bold: true, color: BRAND, gap: 6 });
  }

  // "Name" row for per-person tasks (Personal Information / Upload ID). The name
  // isn't a form response, so it's rendered explicitly here — in the shared
  // helper so both the single-task and combined "Download All" exports print it.
  if (task.ownerName) {
    w.kv("Name", task.ownerName, { indent: 8, gap: 4 });
  }

  const responses = task.responses ?? [];
  if (responses.length === 0) {
    w.text("No client responses submitted.", { size: 9.5, color: [150, 150, 150], gap: 6 });
    return;
  }
  for (const r of responses) {
    const label = (r.field_label || r.field_id || "Field").toString();
    let val: string;
    if (r.field_type === "file") {
      val = r.file_name
        ? `${r.file_name}${r.file_url ? "" : " (no file URL)"}`
        : r.file_url
          ? "Uploaded file"
          : "No file";
    } else {
      val = (r.value ?? "").toString().trim() || "—";
    }
    w.kv(label, val, { indent: 8, gap: 4 });
  }
  // List uploaded documents for this task in a compact, explicit way.
  const files = responses.filter((rr) => rr.field_type === "file" && (rr.file_name || rr.file_url));
  if (files.length > 0) {
    w.text("Documents", { size: 11, bold: true, color: [40, 40, 40], gap: 6 });
    for (const f of files) {
      const name = f.file_name || "(uploaded file)";
      const note = f.file_url ? "Available (embedded)" : "Uploaded (no public URL)";
      w.kv(name, note, { indent: 12, labelW: 220, size: 9, gap: 4 });
    }
  }
  w.spacer(8);
}

// ─────────────────────────── file embedding (pdf-lib) ───────────────────────────

const A4 = { w: 595.28, h: 841.89 };

// pdf-lib's standard fonts encode WinAnsi only — strip anything outside the
// printable Latin range so drawText never throws on an exotic filename.
function ascii(str: string): string {
  return (str ?? "")
    .replace(/[^\x20-\x7E]/g, "?")
    .slice(0, 200);
}

function detectKind(name?: string | null, contentType?: string | null): "pdf" | "jpg" | "png" | "other" {
  const n = (name ?? "").toLowerCase();
  const ct = (contentType ?? "").toLowerCase();
  if (n.endsWith(".pdf") || ct.includes("pdf")) return "pdf";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg") || ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (n.endsWith(".png") || ct.includes("png")) return "png";
  return "other";
}

async function fetchFile(
  url: string,
): Promise<{ bytes: Uint8Array; contentType: string | null } | null> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { bytes: new Uint8Array(buf), contentType: res.headers.get("content-type") };
  } catch {
    return null;
  }
}

type PdfLib = typeof import("pdf-lib");

function drawWrapped(
  page: any,
  font: any,
  text: string,
  x: number,
  startY: number,
  maxW: number,
  size: number,
): number {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  let line = "";
  let y = startY;
  const lineH = size * 1.3;
  const flush = () => {
    if (line) page.drawText(line, { x, y, size, font });
    y -= lineH;
    line = "";
  };
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxW && line) {
      flush();
      line = word;
    } else {
      line = candidate;
    }
  }
  flush();
  return y;
}

function addDividerPage(pdfDoc: any, font: any, lib: PdfLib, caption: string) {
  const page = pdfDoc.addPage([A4.w, A4.h]);
  const { rgb } = lib;
  page.drawText("Attached Document", {
    x: 48,
    y: A4.h - 64,
    size: 16,
    font,
    color: rgb(BRAND[0] / 255, BRAND[1] / 255, BRAND[2] / 255),
  });
  drawWrapped(page, font, caption, 48, A4.h - 96, A4.w - 96, 11);
}

function addNotePage(pdfDoc: any, font: any, lib: PdfLib, caption: string, note: string) {
  const page = pdfDoc.addPage([A4.w, A4.h]);
  const { rgb } = lib;
  page.drawText("Attached Document", {
    x: 48,
    y: A4.h - 64,
    size: 16,
    font,
    color: rgb(BRAND[0] / 255, BRAND[1] / 255, BRAND[2] / 255),
  });
  // Make the caption slightly larger and darker so it's clearly visible.
  const afterCaption = drawWrapped(page, font, caption, 48, A4.h - 96, A4.w - 96, 12);
  drawWrapped(page, font, note, 48, afterCaption - 14, A4.w - 96, 10);
}

function addImagePage(pdfDoc: any, font: any, lib: PdfLib, caption: string, img: any) {
  const page = pdfDoc.addPage([A4.w, A4.h]);
  const { rgb } = lib;
  const margin = 40;
  const captionY = A4.h - margin;
  // Slightly larger, higher-contrast caption for uploaded images.
  page.drawText(ascii(caption), {
    x: margin,
    y: captionY,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  });
  const maxW = A4.w - margin * 2;
  const maxH = A4.h - margin * 2 - 24;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, {
    x: (A4.w - w) / 2,
    y: captionY - 24 - h,
    width: w,
    height: h,
  });
}

async function appendFileToDoc(
  pdfDoc: any,
  font: any,
  lib: PdfLib,
  caption: string,
  r: PdfResponse,
): Promise<void> {
  if (!r.file_url) return;
  const file = await fetchFile(r.file_url);
  if (!file) {
    addNotePage(
      pdfDoc,
      font,
      lib,
      caption,
      "This file could not be downloaded for embedding (it may require sign-in or block cross-origin access). It remains available via its original link.",
    );
    return;
  }
  const kind = detectKind(r.file_name, file.contentType);
  try {
    if (kind === "pdf") {
      // Add a small caption page (no horizontal divider) so the attachment's
      // origin is explicit, then append the PDF pages.
      addNotePage(pdfDoc, font, lib, caption, "");
      const src = await lib.PDFDocument.load(file.bytes, { ignoreEncryption: true });
      const pages = await pdfDoc.copyPages(src, src.getPageIndices());
      for (const p of pages) pdfDoc.addPage(p);
    } else if (kind === "jpg" || kind === "png") {
      const img = kind === "jpg" ? await pdfDoc.embedJpg(file.bytes) : await pdfDoc.embedPng(file.bytes);
      // Try to place the image on the existing last page (the text report)
      // to avoid leaving a mostly-empty page between the report and images.
      try {
        const pages = pdfDoc.getPages();
        const last = pages[pages.length - 1];
        if (last) {
          const margin = 40;
          const captionSize = 11;
          // When drawing onto the last page, only render the file name
          // (avoid repeating the task title). If the caption contains a
          // hyphenated filename, take the last part.
          const displayCaption = caption.includes(" - ") ? caption.split(" - ").pop() || caption : caption;
          const { rgb } = lib;
          // Place the image on the right column below the header so it
          // doesn't overlap the main report title on the left.
          const maxW = (A4.w - margin * 3) / 2; // right-hand column
          const maxH = A4.h - margin * 2 - 60;
          const scale = Math.min(maxW / img.width, maxH / img.height, 1);
          const w = img.width * scale;
          const h = img.height * scale;
          const captionY = A4.h - margin - 20; // slightly below page top
          const imgY = captionY - 20 - h;
          if (imgY > margin) {
            // draw caption on left area of page
            last.drawText(ascii(displayCaption), {
              x: margin,
              y: captionY,
              size: captionSize,
              font,
              color: rgb(BRAND[0] / 255, BRAND[1] / 255, BRAND[2] / 255),
            });
            // draw image on the right half
            last.drawImage(img, { x: A4.w - margin - w, y: imgY, width: w, height: h });
            return;
          }
        }
      } catch {
        // ignore and fall back to creating a dedicated image page
      }
      // Fallback: create a dedicated image page with caption.
      if (kind === "jpg") {
        addImagePage(pdfDoc, font, lib, caption, img);
      } else {
        addImagePage(pdfDoc, font, lib, caption, img);
      }
    } else {
      addNotePage(
        pdfDoc,
        font,
        lib,
        caption,
        "This file type can't be previewed inline. It remains available via its original link.",
      );
    }
  } catch {
    addNotePage(
      pdfDoc,
      font,
      lib,
      caption,
      "This file could not be embedded (it may be an unsupported or corrupted format). It remains available via its original link.",
    );
  }
}

// ─────────────────────────── finalize + download ───────────────────────────

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function sanitizeFile(name: string): string {
  return (name || "document")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

async function finalizeAndDownload(
  doc: JsPdfDoc,
  groups: EmbedGroup[],
  fileName: string,
): Promise<void> {
  const lib = await import("pdf-lib");
  const reportBuf: ArrayBuffer = doc.output("arraybuffer");
  let pdfDoc: any;
  try {
    pdfDoc = await lib.PDFDocument.load(reportBuf);
  } catch {
    // pdf-lib couldn't re-open the jsPDF output — ship the text report alone
    // rather than failing the whole download.
    triggerDownload(new Blob([reportBuf], { type: "application/pdf" }), fileName);
    return;
  }
  const font = await pdfDoc.embedFont(lib.StandardFonts.Helvetica);
  for (const g of groups) {
    for (const r of g.responses ?? []) {
      if (r.field_type !== "file" || !r.file_url) continue;
      // Use an ASCII hyphen instead of an em-dash so the embedded-font
      // WinAnsi encoding doesn't replace it with a question mark.
      const caption = `${g.caption} - ${r.file_name || "file"}`;
      await appendFileToDoc(pdfDoc, font, lib, caption, r);
    }
  }
  const out = await pdfDoc.save();
  triggerDownload(new Blob([out as BlobPart], { type: "application/pdf" }), fileName);
}

// ─────────────────────────── public entry points ───────────────────────────

/** Build and download a PDF for a single task: its info, client responses, and
 *  every file attached to it (images rendered, uploaded PDFs appended). */
export async function downloadTaskPdf(deal: PdfDealMeta, task: PdfTaskInput): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const g = pkgGeom(doc);

  const textResponses = (task.responses ?? []).filter((r) => r.field_type !== "file");
  const fileResponses = (task.responses ?? []).filter((r) => r.field_type === "file" && r.file_url);

  let y = g.top;
  const flow = {
    page() {
      doc.addPage();
      y = g.top;
    },
    band(title: string, label?: string) {
      if (y + 62 > g.bottom) {
        doc.addPage();
        y = g.top;
      }
      y = drawBand(doc, g, y, title, label);
    },
    kv(label: string, value: string) {
      const h = kvRowHeight(doc, label, value, 180, g.contentW);
      if (y + h > g.bottom) {
        doc.addPage();
        y = g.top;
      }
      y = drawKvRow(doc, g.M, y, g.contentW, label, value, 180);
    },
  };

  const inserts: Array<{ afterPage: number; bytes: Uint8Array }> = [];

  if (textResponses.length > 0 || !!task.ownerName) {
    const bandTitle = task.ownerName || task.title || "Details";
    const bandLabel = task.ownerName ? task.title : undefined;
    flow.band(bandTitle, bandLabel);
    if (task.ownerName) {
      flow.kv("Name", task.ownerName);
    }
    for (const r of textResponses) {
      const label = (r.field_label || r.field_id || "Field").toString();
      const val = (r.value ?? "").toString().trim() || "—";
      flow.kv(label, val);
    }
  } else {
    flow.band(task.title || "Task", undefined);
    flow.kv("No client responses submitted.", "—");
  }

  let docIdx = 0;
  const totalFiles = fileResponses.length;
  for (const r of fileResponses) {
    docIdx++;
    const fname = r.file_name || "Document";
    const file = await fetchFile(r.file_url!);
    if (file) {
      const kind = detectKind(r.file_name, file.contentType);
      if (kind === "jpg" || kind === "png") {
        const img = await loadImageEl(file.bytes, kind);
        if (img) {
          pkgImagePage(doc, task.ownerName || task.title || "Document", task.ownerName ? task.title : "", img, kind === "png" ? "PNG" : "JPEG");
          continue;
        }
        pkgAttachedTitle(doc, docIdx, totalFiles, task.title || "Document", fname);
        pkgPlaceholder(doc, fname, "This image could not be rendered. It remains available via its original link.", false);
      } else if (kind === "pdf") {
        pkgAttachedTitle(doc, docIdx, totalFiles, task.title || "Document", fname);
        pkgPlaceholder(doc, fname, "The original document is merged into the package at this position.", true);
        inserts.push({ afterPage: doc.getNumberOfPages(), bytes: file.bytes });
      } else {
        pkgAttachedTitle(doc, docIdx, totalFiles, task.title || "Document", fname);
        pkgPlaceholder(doc, fname, "This file type can't be previewed inline. It remains available via its original link.", false);
      }
    } else {
      pkgAttachedTitle(doc, docIdx, totalFiles, task.title || "Document", fname);
      pkgPlaceholder(doc, fname, "This file could not be downloaded for embedding (it may require sign-in or block cross-origin access). It remains available via its original link.", false);
    }
  }

  stampChrome(doc, deal);

  const fileName = `Task - ${sanitizeFile(task.title || "task")}${task.ownerName ? ` - ${sanitizeFile(task.ownerName)}` : ""}.pdf`;
  const reportBuf: ArrayBuffer = doc.output("arraybuffer");
  const lib = await import("pdf-lib");
  let pdfDoc: any;
  try {
    pdfDoc = await lib.PDFDocument.load(reportBuf);
  } catch {
    triggerDownload(new Blob([reportBuf], { type: "application/pdf" }), fileName);
    return;
  }

  inserts.sort((a, b) => a.afterPage - b.afterPage);
  let offset = 0;
  for (const ins of inserts) {
    try {
      const src = await lib.PDFDocument.load(ins.bytes, { ignoreEncryption: true });
      const copied = await pdfDoc.copyPages(src, src.getPageIndices());
      let at = ins.afterPage + offset;
      for (const p of copied) {
        pdfDoc.insertPage(at, p);
        at++;
      }
      offset += copied.length;
    } catch {
      /* leave the placeholder page standing if this PDF can't be merged */
    }
  }

  const out = await pdfDoc.save();
  triggerDownload(new Blob([out as BlobPart], { type: "application/pdf" }), fileName);
}

// ═══════════════════════ Deal Package (branded layout) ═══════════════════════
// A polished, self-contained "Deal Package" for downloadDealPdf: a cover page,
// section divider pages, key/value tables with row rules, a running header +
// footer on every page, and styled attachment title + placeholder pages.
// Uploaded PDFs are inserted right after their title page (via pdf-lib); images
// are drawn onto their own styled page by jsPDF.

const PKG = {
  ink: [24, 24, 27] as [number, number, number], // near-black (slate-900)
  sub: [107, 114, 128] as [number, number, number], // slate-500
  faint: [148, 156, 168] as [number, number, number], // slate-400
  hair: [224, 228, 234] as [number, number, number], // slate-200 hairline
  panel: [246, 247, 249] as [number, number, number], // slate-50 band fill
  brand: BRAND,
};

function pkgGeom(doc: JsPdfDoc) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 64; // side margin
  const top = 104; // content top (clears the running header at y=68)
  const bottom = pageH - 76; // content bottom (clears the running footer)
  return { pageW, pageH, M, top, bottom, contentW: pageW - M * 2 };
}

function setDash(doc: JsPdfDoc, arr: number[]) {
  try {
    (doc as any).setLineDashPattern(arr, 0);
  } catch {
    try {
      (doc as any).setLineDash(arr);
    } catch {
      /* older jsPDF — dash unsupported, fall back to solid */
    }
  }
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

// Split a stored property address ("Sale of 461 King Street West, Toronto, ON
// M5V 1K4") into a display title ("461 King Street West") + locality subtitle.
function splitAddress(addr?: string | null): { title: string; locality: string } {
  const raw = (addr ?? "")
    .replace(/^\s*(purchase\s*&\s*sale|purchase|sale)\s+of\s+/i, "")
    .trim();
  if (!raw) return { title: "", locality: "" };
  const ci = raw.indexOf(",");
  if (ci === -1) return { title: raw, locality: "" };
  return { title: raw.slice(0, ci).trim(), locality: raw.slice(ci + 1).trim() };
}

async function loadImageEl(bytes: Uint8Array, kind: "jpg" | "png"): Promise<HTMLImageElement | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: kind === "png" ? "image/png" : "image/jpeg",
    });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image load error"));
      img.src = url;
    });
    return img;
  } catch {
    return null;
  }
}

// A key/value row: gray label column, bold value column, hairline underneath.
function kvRowHeight(doc: JsPdfDoc, label: string, value: string, labelW: number, tableW: number): number {
  doc.setFontSize(10.5);
  doc.setFont("helvetica", "normal");
  const labelLines: string[] = doc.splitTextToSize(String(label ?? ""), labelW - 10);
  doc.setFont("helvetica", "bold");
  const valueLines: string[] = doc.splitTextToSize(String(value ?? "—"), tableW - labelW);
  const lh = 10.5 * 1.35;
  const rows = Math.max(labelLines.length, valueLines.length, 1);
  return 12 + rows * lh + 12;
}

function drawKvRow(
  doc: JsPdfDoc,
  x0: number,
  y: number,
  tableW: number,
  label: string,
  value: string,
  labelW: number,
): number {
  doc.setFontSize(10.5);
  const lh = 10.5 * 1.35;
  doc.setFont("helvetica", "normal");
  const labelLines: string[] = doc.splitTextToSize(String(label ?? ""), labelW - 10);
  doc.setFont("helvetica", "bold");
  const valueLines: string[] = doc.splitTextToSize(String(value ?? "—"), tableW - labelW);
  const rows = Math.max(labelLines.length, valueLines.length, 1);
  const h = 12 + rows * lh + 12;
  const baseY = y + 12 + lh * 0.8;

  doc.setFont("helvetica", "normal");
  doc.setTextColor(...PKG.sub);
  labelLines.forEach((ln, i) => doc.text(ln, x0, baseY + i * lh));

  doc.setFont("helvetica", "bold");
  doc.setTextColor(...PKG.ink);
  valueLines.forEach((ln, i) => doc.text(ln, x0 + labelW, baseY + i * lh));

  doc.setDrawColor(...PKG.hair);
  doc.setLineWidth(0.7);
  doc.line(x0, y + h, x0 + tableW, y + h);
  return y + h;
}

// Gray band with a red left bar: bold title + optional letter-spaced label.
function drawBand(doc: JsPdfDoc, g: ReturnType<typeof pkgGeom>, y: number, title: string, label?: string): number {
  const h = 42;
  doc.setFillColor(...PKG.panel);
  doc.rect(g.M, y, g.contentW, h, "F");
  doc.setFillColor(...PKG.brand);
  doc.rect(g.M, y, 4, h, "F");

  const tx = g.M + 18;
  const cy = y + h / 2 + 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...PKG.ink);
  const t = String(title ?? "");
  doc.text(t, tx, cy);
  if (label) {
    const tw = doc.getTextWidth(t);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(...PKG.faint);
    doc.text(String(label).toUpperCase(), tx + tw + 12, cy, { charSpace: 1.4 } as any);
  }
  return y + h + 18;
}

function pkgCover(doc: JsPdfDoc, deal: PdfDealMeta) {
  const g = pkgGeom(doc);
  const cx = g.pageW / 2;
  const { title, locality } = splitAddress(deal.propertyAddress);

  let y = 236;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...PKG.brand);
  doc.text("DEAL PACKAGE", cx, y, { align: "center", charSpace: 2.4 } as any);
  y += 40;

  doc.setFont("times", "bold");
  doc.setTextColor(28, 28, 32);
  let ts = 34;
  doc.setFontSize(ts);
  const heading = title || `File ${deal.fileNumber || "—"}`;
  let lines: string[] = doc.splitTextToSize(heading, g.contentW);
  while (ts > 20 && lines.length > 2) {
    ts -= 2;
    doc.setFontSize(ts);
    lines = doc.splitTextToSize(heading, g.contentW);
  }
  const lh = ts * 1.18;
  for (const ln of lines) {
    doc.text(ln, cx, y, { align: "center" } as any);
    y += lh;
  }
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(...PKG.sub);
  const sub = [locality, `File ${deal.fileNumber || "—"}`].filter(Boolean).join("  ·  ");
  doc.text(sub, cx, y, { align: "center" } as any);
  y += 20;

  doc.setDrawColor(...PKG.brand);
  doc.setLineWidth(1.4);
  doc.line(cx - 26, y, cx + 26, y);
  y += 44;

  const rows: Array<[string, string | null | undefined]> = [
    ["File Number", deal.fileNumber],
    ["Type", deal.type],
    ["Status", deal.status],
    ["Property Address", deal.propertyAddress],
    ["Selling Property Address", deal.sellingPropertyAddress],
    ["Closing Date", deal.closingDate],
    ["Price", money(deal.price)],
  ];
  const tableW = Math.min(g.contentW, 480);
  const x0 = cx - tableW / 2;
  for (const [label, val] of rows) {
    if (val && String(val).trim()) {
      y = drawKvRow(doc, x0, y, tableW, label, String(val), 176);
    }
  }
}

function pkgSectionCover(
  doc: JsPdfDoc,
  index: number,
  title: string,
  fileNames: string[],
) {
  doc.addPage();
  const g = pkgGeom(doc);
  const cx = g.pageW / 2;
  const bandTop = g.pageH * 0.36;
  const bandBot = g.pageH * 0.64;

  doc.setFillColor(...PKG.panel);
  doc.rect(0, bandTop, g.pageW, bandBot - bandTop, "F");
  doc.setDrawColor(...PKG.brand);
  doc.setLineWidth(1);
  doc.line(0, bandTop, g.pageW, bandTop);
  doc.line(0, bandBot, g.pageW, bandBot);

  let y = (bandTop + bandBot) / 2 - 34;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...PKG.brand);
  doc.text(`SECTION ${index}`, cx, y, { align: "center", charSpace: 2.6 } as any);
  y += 32;

  doc.setFont("times", "bold");
  doc.setFontSize(26);
  doc.setTextColor(28, 28, 32);
  const lines: string[] = doc.splitTextToSize(String(title ?? ""), g.contentW);
  for (const ln of lines) {
    doc.text(ln, cx, y, { align: "center" } as any);
    y += 30;
  }
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PKG.sub);
  const unique = Array.from(new Set(fileNames.filter(Boolean))).slice(0, 6);
  for (const n of unique) {
    doc.text(n, cx, y, { align: "center" } as any);
    y += 15;
  }
}

function pkgAttachedTitle(
  doc: JsPdfDoc,
  idx: number,
  total: number,
  sectionTitle: string,
  fileName: string,
) {
  doc.addPage();
  const g = pkgGeom(doc);

  const label = total > 1 ? `Attached Document · ${idx} of ${total}` : "Attached Document";
  let y = drawBand(doc, g, g.top, sectionTitle || "Attached Document", label);
  y += 24;

  doc.setFont("courier", "bold");
  doc.setFontSize(10.5);
  const fname = String(fileName || "document");
  const textW = doc.getTextWidth(fname);
  const chipW = Math.min(g.contentW, textW + 32);
  const chipH = 34;
  doc.setFillColor(...PKG.panel);
  doc.rect(g.M, y, chipW, chipH, "F");
  doc.setFillColor(...PKG.brand);
  doc.rect(g.M, y, 4, chipH, "F");
  doc.setTextColor(...PKG.ink);
  doc.text(fname, g.M + 16, y + chipH / 2 + 4, { maxWidth: chipW - 28 } as any);
}

function pkgPlaceholder(doc: JsPdfDoc, fileName: string, note: string, embedded: boolean) {
  doc.addPage();
  const g = pkgGeom(doc);
  const bx = g.M;
  const by = g.top;
  const bw = g.contentW;
  const bh = g.bottom - g.top;

  doc.setDrawColor(...PKG.hair);
  doc.setLineWidth(1);
  setDash(doc, [3, 3]);
  doc.roundedRect(bx, by, bw, bh, 8, 8, "S");
  setDash(doc, []);

  const cx = g.pageW / 2;
  let y = by + 64;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8.5);
  doc.setTextColor(...PKG.brand);
  doc.text(embedded ? "ORIGINAL ATTACHMENT · EMBEDDED HERE" : "ORIGINAL ATTACHMENT", cx, y, {
    align: "center",
    charSpace: 2,
  } as any);
  y += 28;

  doc.setFont("courier", "bold");
  doc.setFontSize(12);
  doc.setTextColor(...PKG.ink);
  const nameLines: string[] = doc.splitTextToSize(String(fileName || "document"), bw - 80);
  for (const ln of nameLines) {
    doc.text(ln, cx, y, { align: "center" } as any);
    y += 18;
  }
  y += 12;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PKG.sub);
  const noteLines: string[] = doc.splitTextToSize(String(note || ""), bw - 120);
  for (const ln of noteLines) {
    doc.text(ln, cx, y, { align: "center" } as any);
    y += 18;
  }
}

function pkgImagePage(
  doc: JsPdfDoc,
  heading: string,
  sublabel: string,
  img: HTMLImageElement,
  fmt: "JPEG" | "PNG",
) {
  doc.addPage();
  const g = pkgGeom(doc);
  const y = drawBand(doc, g, g.top, heading || "Document", sublabel || undefined);

  const cardX = g.M;
  const cardY = y;
  const cardW = g.contentW;
  const cardH = g.bottom - y;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...PKG.hair);
  doc.setLineWidth(1);
  doc.roundedRect(cardX, cardY, cardW, cardH, 8, 8, "FD");

  const pad = 24;
  const maxW = cardW - pad * 2;
  const maxH = cardH - pad * 2;
  const ow = img.naturalWidth || 1;
  const oh = img.naturalHeight || 1;
  const scale = Math.min(maxW / ow, maxH / oh, 1);
  const iw = ow * scale;
  const ih = oh * scale;
  const ix = cardX + (cardW - iw) / 2;
  const iy = cardY + (cardH - ih) / 2;
  try {
    doc.addImage(img, fmt, ix, iy, iw, ih);
  } catch {
    /* if the image can't be drawn, the card is left empty rather than failing */
  }
}

// Running header + footer stamped on every jsPDF page (done before pdf-lib
// inserts the raw attachment pages, which are left as-is).
function stampChrome(doc: JsPdfDoc, deal: PdfDealMeta) {
  const g = pkgGeom(doc);
  const total = doc.getNumberOfPages();
  const fileNum = deal.fileNumber || "—";
  const { title } = splitAddress(deal.propertyAddress);
  const footRight = [title.toUpperCase(), fileNum].filter(Boolean).join("  ·  ");

  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...PKG.faint);
    doc.text(`DEAL FILE · ${fileNum}`, g.M, 56, { charSpace: 1.4 } as any);

    doc.setFontSize(12);
    doc.setTextColor(...PKG.ink);
    doc.text("iClosed", g.pageW - g.M, 56, { align: "right" } as any);

    doc.setDrawColor(...PKG.brand);
    doc.setLineWidth(1.2);
    doc.line(g.M, 68, g.pageW - g.M, 68);

    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...PKG.brand);
    doc.text("CONFIDENTIAL", g.M, g.pageH - 40, { charSpace: 1.4 } as any);
    doc.setTextColor(...PKG.faint);
    doc.text(footRight, g.pageW - g.M, g.pageH - 40, { align: "right", charSpace: 1.2 } as any);
  }
}

/** Build and download a single self-contained, branded "Deal Package" PDF for
 *  the whole deal: a cover page, then each milestone rendered as an info block
 *  (bands + key/value tables) or a document section (divider + attachment title
 *  pages) with every uploaded PDF merged inline and every image drawn on its own
 *  styled page. */
export async function downloadDealPdf(
  deal: PdfDealMeta,
  sections: PdfDealSection[],
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const g = pkgGeom(doc);

  // Fetch each uploaded file once; reuse the bytes for both detection and the
  // final pdf-lib merge.
  type Fetched = { bytes: Uint8Array; kind: "pdf" | "jpg" | "png" | "other"; ok: boolean };
  const cache = new Map<string, Fetched>();
  const getFile = async (r: PdfResponse): Promise<Fetched | null> => {
    if (!r.file_url) return null;
    const cached = cache.get(r.file_url);
    if (cached) return cached;
    const file = await fetchFile(r.file_url);
    const entry: Fetched = file
      ? { bytes: file.bytes, kind: detectKind(r.file_name, file.contentType), ok: true }
      : { bytes: new Uint8Array(), kind: detectKind(r.file_name, null), ok: false };
    cache.set(r.file_url, entry);
    return entry;
  };

  // Cover uses the first (already-present) page.
  pkgCover(doc, deal);

  // A small flowing writer for info blocks (band + key/value table), with
  // automatic page breaks. Each block starts on a fresh page.
  let y = g.top;
  const flow = {
    page() {
      doc.addPage();
      y = g.top;
    },
    band(title: string, label?: string) {
      if (y + 62 > g.bottom) this.page();
      y = drawBand(doc, g, y, title, label);
    },
    kv(label: string, value: string) {
      const h = kvRowHeight(doc, label, value, 180, g.contentW);
      if (y + h > g.bottom) {
        doc.addPage();
        y = g.top;
      }
      y = drawKvRow(doc, g.M, y, g.contentW, label, value, 180);
    },
  };

  // PDF attachments to merge after their placeholder page (phase B).
  const inserts: Array<{ afterPage: number; bytes: Uint8Array }> = [];

  let sectionNo = 0;
  for (const sec of sections) {
    if (!sec.tasks || sec.tasks.length === 0) continue;

    // Resolve every file in the section up front and gather names for the cover.
    const perTaskFiles: Array<Array<{ r: PdfResponse; f: Fetched | null }>> = [];
    const fileNames: string[] = [];
    let fileCount = 0;
    for (const t of sec.tasks) {
      const files: Array<{ r: PdfResponse; f: Fetched | null }> = [];
      for (const r of t.responses ?? []) {
        if (r.field_type === "file" && r.file_url) {
          files.push({ r, f: await getFile(r) });
          fileNames.push(r.file_name || "Document");
          fileCount++;
        }
      }
      perTaskFiles.push(files);
    }
    const hasDocs = fileCount > 0;
    const sectionTitle = sec.leadType ? `${sec.milestoneTitle} (${sec.leadType})` : sec.milestoneTitle;

    if (hasDocs) {
      sectionNo++;
      pkgSectionCover(doc, sectionNo, sectionTitle, fileNames);
    }

    let docIdx = 0;
    for (let ti = 0; ti < sec.tasks.length; ti++) {
      const t = sec.tasks[ti];
      const files = perTaskFiles[ti];
      const textResponses = (t.responses ?? []).filter((r) => r.field_type !== "file");

      // Info block: person / task heading band + its key/value responses.
      const hasText = textResponses.length > 0 || !!t.ownerName;
      if (hasText) {
        flow.page();
        const bandTitle = t.ownerName || t.title || "Details";
        const bandLabel = t.ownerName ? t.title : t.leadType || undefined;
        flow.band(bandTitle, bandLabel ?? undefined);
        if (t.ownerName) flow.kv("Name", t.ownerName);
        for (const r of textResponses) {
          const label = (r.field_label || r.field_id || "Field").toString();
          const val = (r.value ?? "").toString().trim() || "—";
          flow.kv(label, val);
        }
      }

      // Document block: one title page per file, then the embedded content.
      for (const { r, f } of files) {
        docIdx++;
        const fname = r.file_name || "Document";
        if (f && f.ok && (f.kind === "jpg" || f.kind === "png")) {
          const img = await loadImageEl(f.bytes, f.kind);
          if (img) {
            const heading = t.ownerName || t.title || "Document";
            const sub = t.ownerName ? t.title : t.leadType || "";
            pkgImagePage(doc, heading, sub, img, f.kind === "png" ? "PNG" : "JPEG");
            continue;
          }
          pkgAttachedTitle(doc, docIdx, fileCount, sectionTitle, fname);
          pkgPlaceholder(doc, fname, "This image could not be rendered. It remains available via its original link.", false);
        } else if (f && f.ok && f.kind === "pdf") {
          pkgAttachedTitle(doc, docIdx, fileCount, sectionTitle, fname);
          pkgPlaceholder(doc, fname, "The original document is merged into the package at this position.", true);
          inserts.push({ afterPage: doc.getNumberOfPages(), bytes: f.bytes });
        } else if (f && f.ok) {
          pkgAttachedTitle(doc, docIdx, fileCount, sectionTitle, fname);
          pkgPlaceholder(doc, fname, "This file type can't be previewed inline. It remains available via its original link.", false);
        } else {
          pkgAttachedTitle(doc, docIdx, fileCount, sectionTitle, fname);
          pkgPlaceholder(doc, fname, "This file could not be downloaded for embedding (it may require sign-in or block cross-origin access). It remains available via its original link.", false);
        }
      }
    }
  }

  // Stamp the running header/footer on every jsPDF page before merging raw
  // attachment pages (which stay as their original selves).
  stampChrome(doc, deal);

  // Phase B: merge each uploaded PDF's pages right after its placeholder page.
  const fileName = `Deal ${sanitizeFile(deal.fileNumber)} - Package.pdf`;
  const reportBuf: ArrayBuffer = doc.output("arraybuffer");
  const lib = await import("pdf-lib");
  let pdfDoc: any;
  try {
    pdfDoc = await lib.PDFDocument.load(reportBuf);
  } catch {
    triggerDownload(new Blob([reportBuf], { type: "application/pdf" }), fileName);
    return;
  }

  inserts.sort((a, b) => a.afterPage - b.afterPage);
  let offset = 0;
  for (const ins of inserts) {
    try {
      const src = await lib.PDFDocument.load(ins.bytes, { ignoreEncryption: true });
      const copied = await pdfDoc.copyPages(src, src.getPageIndices());
      let at = ins.afterPage + offset;
      for (const p of copied) {
        pdfDoc.insertPage(at, p);
        at++;
      }
      offset += copied.length;
    } catch {
      /* leave the placeholder page standing if this PDF can't be merged */
    }
  }

  const out = await pdfDoc.save();
  triggerDownload(new Blob([out as BlobPart], { type: "application/pdf" }), fileName);
}
