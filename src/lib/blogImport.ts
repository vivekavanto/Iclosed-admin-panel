import JSZip from "jszip";
import { sanitizeBlogHtml, blogHtmlToText } from "./sanitizeBlogHtml.ts";
import { callGeminiText, BLOG_FILE_LADDER } from "./blogGemini.ts";
import { logger } from "./logger.ts";

/**
 * Turns an uploaded document into the plain text that src/lib/blogFormat.ts and
 * src/lib/blogSeo.ts already know how to work with.
 *
 * This is the "upload the article instead of pasting it" path. Everything
 * downstream is unchanged: the extracted text lands in the same
 * `content_source` an admin would otherwise have pasted, and the same two
 * Gemini steps run over it.
 *
 * ── Why extraction is NOT a model's job (except for PDF) ────────────────
 * DOCX, TXT, MD and HTML are read here, in code, byte by byte. That is a
 * deliberate constraint and the same one src/lib/blogFormat.ts is built
 * around: this blog publishes Ontario real-estate law that answer engines
 * quote verbatim, so the author's sentences must arrive exactly as written.
 * Code that unzips a .docx and concatenates its text runs cannot paraphrase;
 * a model asked to "read out this document" can, and there would be no
 * original to check it against.
 *
 * PDF is the exception, because a PDF has no recoverable text layer we can
 * rely on (a scan has none at all) and this repo carries no PDF text
 * extractor. That branch DOES go through Gemini, and it is the only import
 * that comes back flagged `needsProofread` — see transcribePdf() below.
 */

/** Matches the drawer's document cap; an article is text, not a scan bundle. */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB

/** What blogFormat/blogSeo accept. Checked here so the error names the file. */
const MAX_EXTRACTED_CHARS = 60_000;

export type ImportKind = "text" | "markdown" | "html" | "docx" | "pdf";

export type ExtractedArticle = {
  /** The author's words as plain text — what goes into `content_source`. */
  text: string;
  /** A title taken from the document, if it clearly had one. */
  title: string | null;
  /**
   * Article HTML lifted straight from the source, for formats that already
   * carry structure. Set only for HTML uploads; when present the caller skips
   * the Gemini formatting step entirely.
   */
  preformattedHtml: string | null;
  kind: ImportKind;
  warnings: string[];
  /** True only for PDF: a model produced this text and nobody has checked it. */
  needsProofread: boolean;
};

export type ExtractOutcome =
  | { ok: true; data: ExtractedArticle }
  | { ok: false; error: string };

const KIND_BY_EXT: Record<string, ImportKind> = {
  txt: "text",
  text: "text",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  docx: "docx",
  pdf: "pdf",
};

export const IMPORT_ACCEPT = ".docx,.pdf,.txt,.md,.markdown,.html,.htm";
export const IMPORT_LABEL = "Word (.docx), PDF, Markdown, plain text or HTML";

/**
 * The format of an upload, decided by EXTENSION rather than content type.
 *
 * Browsers disagree about .md (empty string on Windows, text/markdown on
 * macOS) and about .docx often enough that trusting `file.type` would reject
 * perfectly good files on one machine and accept them on another. The
 * extension is what the author actually controls.
 */
export function importKindFor(fileName: string): ImportKind | null {
  const ext = (fileName.split(".").pop() || "").toLowerCase();
  return KIND_BY_EXT[ext] ?? null;
}

// ── XML / entity helpers ───────────────────────────────────────────────

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Last, so that "&amp;lt;" survives as the literal "&lt;" the author typed.
    .replace(/&amp;/g, "&");
}

// ── DOCX ───────────────────────────────────────────────────────────────

/**
 * The visible text of one `<w:p>` paragraph, in document order.
 *
 * Only `<w:t>` runs are read. That silently and correctly drops the two things
 * a naive tag-strip would wrongly include: `<w:delText>` (text the author
 * deleted with track-changes on, which must not come back from the dead) and
 * `<w:instrText>` (field codes such as PAGEREF, which are machinery, not prose).
 */
function paragraphText(xml: string): string {
  let out = "";
  const token = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>/g;

  for (let m = token.exec(xml); m; m = token.exec(xml)) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[0].startsWith("<w:tab")) out += " ";
    else out += "\n";
  }
  return out;
}

/** "Heading2" and "Heading 2" both occur in the wild; so does "Title". */
function headingLevel(paraXml: string): number | null {
  const m = paraXml.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/i);
  if (!m) return null;
  const style = m[1].replace(/\s+/g, "").toLowerCase();
  if (style === "title") return 1;
  const h = style.match(/^heading(\d)$/);
  return h ? Number(h[1]) : null;
}

/**
 * A .docx as Markdown-ish plain text.
 *
 * Headings come out as `##` and list items as `-`, which is not decoration:
 * blogFormat's prompt is forbidden from inventing headings for text that has
 * none, so a Word heading that arrived as an ordinary line would be published
 * as an ordinary paragraph and the article's structure would quietly be lost.
 * The markers survive verifyWordsPreserved() untouched, because it counts
 * alphanumeric words and ignores punctuation.
 */
async function extractDocx(buffer: ArrayBuffer): Promise<ExtractOutcome> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return { ok: false, error: "That .docx could not be opened. Re-save it from Word and try again." };
  }

  const entry = zip.file("word/document.xml");
  if (!entry) {
    return {
      ok: false,
      error:
        "That file is not a Word document. A .doc saved in the old format has to be re-saved as .docx first.",
    };
  }

  const xml = await entry.async("string");
  const warnings: string[] = [];

  const lines: string[] = [];
  let title: string | null = null;

  // Split on the closing tag so a paragraph's properties (<w:pPr>, which holds
  // the style and the list marker) stay attached to the runs they describe.
  for (const chunk of xml.split("</w:p>")) {
    if (!chunk.includes("<w:p")) continue;

    const text = paragraphText(chunk).trim();
    if (!text) {
      lines.push("");
      continue;
    }

    const level = headingLevel(chunk);

    // The first Heading 1 / Title is the article's title, and is taken OUT of
    // the body: the format prompt is told not to repeat the title as a heading,
    // so leaving it in would produce a duplicate on the page.
    if (level !== null && level <= 1 && !title) {
      title = text;
      continue;
    }

    if (level !== null) {
      // h1 is not an allowed tag in a body (the page renders the post title as
      // the sole h1), so Heading 1s after the first are demoted to h2.
      lines.push(`${"#".repeat(Math.min(Math.max(level, 2), 4))} ${text}`);
    } else if (/<w:numPr\b/.test(chunk)) {
      lines.push(`- ${text}`);
    } else {
      lines.push(text);
    }
  }

  if (/<w:drawing\b|<w:pict\b/.test(xml)) {
    warnings.push(
      "The document contained images. Only its text was imported — upload any image you need as the cover image, or add it to the HTML by hand.",
    );
  }

  return {
    ok: true,
    data: {
      text: normaliseBlankLines(lines.join("\n")),
      title,
      preformattedHtml: null,
      kind: "docx",
      warnings,
      needsProofread: false,
    },
  };
}

// ── HTML ───────────────────────────────────────────────────────────────

/**
 * An HTML upload keeps its own markup instead of being flattened to text.
 *
 * Round-tripping it through blogFormat would hand Gemini a plain-text copy in
 * which every hyperlink, table cell and list boundary had already been
 * destroyed — and no amount of re-formatting brings a URL back. The sanitizer
 * is the same allowlist the editor and the portal enforce, so what survives
 * here is exactly what would have survived a paste.
 */
function extractHtml(raw: string, fileName: string): ExtractOutcome {
  // Prefer the <body>; a file saved from a browser carries a <head> full of
  // scripts and meta tags that are not the article.
  const body = raw.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? raw;

  const h1 = body.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const docTitle = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title = blogHtmlToText(h1 ?? docTitle ?? "") || null;

  // The title is rendered separately by the page, so the source h1 is dropped
  // rather than published twice.
  const withoutH1 = h1 ? body.replace(/<h1\b[^>]*>[\s\S]*?<\/h1>/i, "") : body;
  const html = sanitizeBlogHtml(withoutH1);
  const text = blogHtmlToText(html);

  if (!text.trim()) {
    return { ok: false, error: `${fileName} has no article text in it.` };
  }

  return {
    ok: true,
    data: {
      text,
      title,
      preformattedHtml: html,
      kind: "html",
      warnings: [
        "The HTML was kept as written and sanitized, not re-formatted by AI. Check the preview before publishing.",
      ],
      needsProofread: false,
    },
  };
}

// ── PDF ────────────────────────────────────────────────────────────────

const PDF_PROMPT = `Transcribe the article in the attached PDF into plain text.

You are a transcriber. You are NOT editing, summarising or improving anything.

RULES:
- Reproduce every sentence EXACTLY as written, including spelling, capitalisation,
  punctuation, figures, dollar amounts, dates and legal terms.
- Do not add an introduction, a summary, a conclusion or any commentary of your own.
- Do not omit paragraphs, however repetitive they look.
- Skip running headers, running footers, page numbers and the firm's letterhead.
  Those are page furniture, not the article.
- Put a blank line between paragraphs.
- Prefix a section heading with "## " and a sub-heading with "### ", using the
  author's own heading words.
- Prefix a bulleted or numbered list item with "- ".
- If the PDF's first line is the article's title, put it on its own first line
  prefixed with "# ".
- Output the transcription only. No preamble, no code fences, no JSON.`;

/**
 * The text of a PDF, read by Gemini.
 *
 * The one import that cannot be verified. Everywhere else in the blog pipeline
 * a model's claim is checked against a source we hold — verifyWordsPreserved()
 * for formatting, verifyGrounding() for SEO. Here the model IS the source:
 * there is no original text to diff a transcription against, so the only
 * honest thing to do is say so, which is what `needsProofread` carries up into
 * the editor's warning list.
 */
async function transcribePdf(buffer: ArrayBuffer, fileName: string): Promise<ExtractOutcome> {
  const result = await callGeminiText({
    parts: [
      { text: PDF_PROMPT },
      {
        inline_data: {
          mime_type: "application/pdf",
          data: Buffer.from(buffer).toString("base64"),
        },
      },
    ],
    label: "blogImportPdf",
    ladder: BLOG_FILE_LADDER,
  });

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "GEMINI_ALL_RUNGS_FAILED"
          ? `Could not read ${fileName}. Try again in a moment, or paste the article text instead.`
          : result.error,
    };
  }

  let text = normaliseBlankLines(result.data);
  let title: string | null = null;

  const firstLine = text.split("\n").find((l) => l.trim());
  if (firstLine?.startsWith("# ")) {
    title = firstLine.slice(2).trim();
    text = normaliseBlankLines(text.replace(firstLine, ""));
  }

  if (!text.trim()) {
    return { ok: false, error: `No article text could be read out of ${fileName}.` };
  }

  logger.info(`[blogImport] pdf transcribed with ${result.model} — ${text.length}ch`);

  return {
    ok: true,
    data: {
      text,
      title,
      preformattedHtml: null,
      kind: "pdf",
      warnings: [
        "This PDF was transcribed by AI. Unlike a Word or text upload, nothing here was copied byte for byte — read the article against the original before publishing, especially any figure, date or dollar amount.",
      ],
      needsProofread: true,
    },
  };
}

// ── Plain text / Markdown ──────────────────────────────────────────────

function extractPlain(raw: string, kind: "text" | "markdown"): ExtractOutcome {
  let text = normaliseBlankLines(raw);
  let title: string | null = null;

  // Only an explicit Markdown h1 is treated as the title and removed. A short
  // opening line is NOT: the heuristic would be right often and wrong
  // occasionally, and being wrong means silently deleting the article's first
  // sentence. An author who wants a title can type one into the Title box.
  const firstLine = text.split("\n").find((l) => l.trim());
  if (firstLine && /^#\s+\S/.test(firstLine)) {
    title = firstLine.replace(/^#\s+/, "").trim();
    text = normaliseBlankLines(text.replace(firstLine, ""));
  }

  return {
    ok: true,
    data: { text, title, preformattedHtml: null, kind, warnings: [], needsProofread: false },
  };
}

/** Normalises line endings and collapses runs of blank lines to one. */
function normaliseBlankLines(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    // A zero-width no-break space is what a UTF-8 BOM decodes to, and it would
    // otherwise sit invisibly at the front of the first word.
    .replace(/^﻿/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Entry point ────────────────────────────────────────────────────────

export async function extractBlogArticle(file: File): Promise<ExtractOutcome> {
  if (!file || typeof file.size !== "number") {
    return { ok: false, error: "No file provided." };
  }
  if (file.size === 0) {
    return { ok: false, error: `${file.name} is empty.` };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return {
      ok: false,
      error: `${file.name} is larger than ${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)} MB.`,
    };
  }

  const kind = importKindFor(file.name);
  if (!kind) {
    return { ok: false, error: `Upload a ${IMPORT_LABEL} file.` };
  }

  let outcome: ExtractOutcome;
  switch (kind) {
    case "docx":
      outcome = await extractDocx(await file.arrayBuffer());
      break;
    case "pdf":
      outcome = await transcribePdf(await file.arrayBuffer(), file.name);
      break;
    case "html":
      outcome = extractHtml(await file.text(), file.name);
      break;
    default:
      outcome = extractPlain(await file.text(), kind);
  }

  if (!outcome.ok) return outcome;

  const { text } = outcome.data;
  if (text.trim().length === 0) {
    return { ok: false, error: `No article text could be read out of ${file.name}.` };
  }
  if (text.length > MAX_EXTRACTED_CHARS) {
    return {
      ok: false,
      error: `${file.name} came to ${text.length.toLocaleString()} characters; the limit is ${MAX_EXTRACTED_CHARS.toLocaleString()}. Split it into shorter posts.`,
    };
  }

  // A title taken from the document is only a suggestion; the route decides
  // whether to apply it, because the admin may already have typed one.
  return outcome;
}
