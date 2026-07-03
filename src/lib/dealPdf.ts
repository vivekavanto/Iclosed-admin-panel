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

function writeHeader(w: ReturnType<typeof makeWriter>, deal: PdfDealMeta, title: string) {
  w.text("iClosed", { size: 10, bold: true, color: BRAND, gap: 8 });
  w.text(title, { size: 18, bold: true, color: [20, 20, 20], gap: 4 });
  w.text(`File ${deal.fileNumber || "—"}`, { size: 9, color: [120, 120, 120], gap: 16 });
}

function writeDealMeta(w: ReturnType<typeof makeWriter>, deal: PdfDealMeta) {
  w.text("Deal Information", { size: 13, bold: true, color: [20, 20, 20], gap: 8 });
  const rows: Array<[string, string | null | undefined]> = [
    ["Type", deal.type],
    ["Status", deal.status],
    ["Property Address", deal.propertyAddress],
    ["Selling Property Address", deal.sellingPropertyAddress],
    ["Closing Date", deal.closingDate],
  ];
  for (const [label, val] of rows) {
    if (val && String(val).trim()) w.kv(label, String(val), { gap: 4 });
  }
  w.spacer(10);
}

function writePeople(w: ReturnType<typeof makeWriter>, people?: PdfPerson[]) {
  if (!people || people.length === 0) return;
  w.text("People Involved", { size: 13, bold: true, color: [20, 20, 20], gap: 8 });
  people.forEach((p, i) => {
    const head = [p.name, p.role ? `(${p.role})` : ""].filter(Boolean).join("  ");
    w.text(head, { size: 10.5, bold: true, color: [30, 30, 30], gap: 3 });
    if (p.email && String(p.email).trim()) w.kv("Email", String(p.email), { indent: 12, labelW: 70, size: 9.5, gap: 2 });
    if (p.phone && String(p.phone).trim()) w.kv("Phone", String(p.phone), { indent: 12, labelW: 70, size: 9.5, gap: 2 });
    w.spacer(i === people.length - 1 ? 6 : 8);
  });
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
  const w = makeWriter(doc);
  // Single bold task title with the file number in brackets — the section
  // below renders the client responses without repeating the title.
  const title = task.title || "Untitled task";
  const heading = deal.fileNumber ? `${title} (${deal.fileNumber})` : title;
  w.text("iClosed", { size: 10, bold: true, color: BRAND, gap: 8 });
  w.text(heading, { size: 16, bold: true, color: [20, 20, 20], gap: 12 });
  writeTaskSection(w, task, { showTitle: false });
  // Embed JPG/PNG images inline into the jsPDF report so they appear
  // exactly where the writer left off. Remove any embedded images from
  // the group so finalizeAndDownload only handles remaining files (PDFs/other).
  const group = { caption: task.title || "Task", responses: (task.responses || []).slice() } as EmbedGroup;
  for (let i = group.responses.length - 1; i >= 0; --i) {
    const r = group.responses[i];
    if (r.field_type === "file" && r.file_url) {
      const file = await fetchFile(r.file_url);
      if (file) {
        const kind = detectKind(r.file_name, file.contentType);
        if (kind === "jpg" || kind === "png") {
          // embed into jsPDF and remove from future embedding list
          await (w as any).addImageFromBytes(file.bytes, kind);
          group.responses.splice(i, 1);
        }
      }
    }
  }

  await finalizeAndDownload(
    doc,
    [group],
    `Task - ${sanitizeFile(task.title || "task")}.pdf`,
  );
}

/** Build and download a single self-contained PDF for the whole deal: deal info,
 *  people, every milestone + task + personal-info response, then every uploaded
 *  document embedded inline. */
export async function downloadDealPdf(
  deal: PdfDealMeta,
  sections: PdfDealSection[],
): Promise<void> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const w = makeWriter(doc);
  writeHeader(w, deal, "All Documents & Tasks");
  writeDealMeta(w, deal);
  writePeople(w, deal.people);

  const groups: EmbedGroup[] = [];
  for (const sec of sections) {
    w.spacer(4);
    // Removed horizontal divider line for cleaner PDF output.
    const heading = sec.leadType ? `${sec.milestoneTitle}  (${sec.leadType})` : sec.milestoneTitle;
    w.text(heading, { size: 13.5, bold: true, color: BRAND, gap: 10 });
    if (sec.tasks.length === 0) {
      w.text("No tasks.", { size: 9, color: [150, 150, 150], gap: 6 });
      continue;
    }
    for (const t of sec.tasks) {
      // Show which party the task belongs to (e.g. Co-purchaser / Co-seller)
      if (t.leadType) {
        w.kv("Party", String(t.leadType), { indent: 8, labelW: 120, size: 9.5, gap: 6 });
      }
      writeTaskSection(w, t);
      // Keep embed group caption short (task title + optional party). The
      // full file caption will include the filename when embedding.
      const caption = t.leadType ? `${t.title} (${t.leadType})` : t.title;
      groups.push({ caption, responses: t.responses });
    }
  }
  // Embed JPG/PNG images inline into the jsPDF report before handing off
  // to pdf-lib. Removing embedded images from `groups` avoids double-embedding.
  for (const g of groups) {
    for (let i = (g.responses || []).length - 1; i >= 0; --i) {
      const r = g.responses[i];
      if (r.field_type === "file" && r.file_url) {
        const file = await fetchFile(r.file_url);
        if (file) {
          const kind = detectKind(r.file_name, file.contentType);
          if (kind === "jpg" || kind === "png") {
            await (w as any).addImageFromBytes(file.bytes, kind);
            g.responses.splice(i, 1);
          }
        }
      }
    }
  }

  await finalizeAndDownload(doc, groups, `Deal ${sanitizeFile(deal.fileNumber)} - All Documents.pdf`);
}
