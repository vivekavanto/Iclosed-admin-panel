import JSZip from "jszip";
import { sanitizeBlogHtml, blogHtmlToText } from "./sanitizeBlogHtml.ts";
import { callGeminiJson, callGeminiText, geminiApiKey, BLOG_FILE_LADDER, BLOG_MODEL_LADDER } from "./blogGemini.ts";
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

/** The container file — a multi-article upload can be a genuinely large document. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * The per-post character ceiling. One blog post is one blog post whether it
 * arrived as a single-file upload (extractBlogArticle — REJECTED past this,
 * same as before batch import existed) or as one section of a multi-article
 * document (extractMultipleBlogArticles — FLAGGED past this, never rejected
 * or truncated, because a legal disclosure getting cut off is worse than a
 * long draft). The multi-article path has NO cap on the combined length of
 * all articles together — only on each one individually.
 */
export const MAX_BLOG_CHARS = 60_000;

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

export type MultipleExtractOutcome =
  | { ok: true; data: ExtractedArticle[] }
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
      // The Word level is kept AS WRITTEN, `#` included. It used to be clamped
      // to `##`, which threw away the one thing the splitter needs: a Heading 1
      // (a standalone post's headline) and a Heading 2 (a section inside one
      // post) arrived indistinguishable, so every section looked like a new
      // blog. `#` never reaches the stored body — demoteTopHeadings() turns it
      // into `##` once the article boundaries have been decided.
      lines.push(`${"#".repeat(Math.min(level, 4))} ${text}`);
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
- Prefix an ARTICLE'S OWN HEADLINE with "# " — the first line if it is the
  title, and the headline of any further standalone article the file contains.
  Use "# " for nothing else: a section heading inside an article is "## ".
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

// ── Multiple article extraction ────────────────────────────────────────
/**
 * Headings that mark a SECTION of one article, never the start of a new one.
 *
 * This list is load-bearing in a way it was not before: if the document's
 * SHALLOWEST heading level contains one of these, that level is a section
 * level, and the document is treated as ONE article no matter how many
 * headings it has (see mainHeadings()). A document whose top-level headings
 * include "FAQ" or "Conclusion" is an article with an FAQ, not a pile of
 * articles one of which is called "FAQ".
 *
 * "Continue the Series" is deliberately NOT here — it moved to
 * SEPARATOR_SERIES, where it now BEGINS a post instead of proving there is
 * only one. A phrase must never sit in both lists.
 */
const INTERNAL_SUBHEADING =
  /^(?:#{1,6}\s+)?(?:\d+[.)]\s+|introduction\b|overview\b|background\b|key\s+takeaways?\b|takeaways?\b|conclusion\b|final\s+thoughts\b|(?:the\s+)?bottom\s+line\b|faqs?\b|frequently\s+asked\s+questions\b|common\s+questions\b|what\s+you\s+need\s+to\s+know\b|(?:in\s+)?summary\b|table\s+of\s+contents\b|next\s+steps\b|what.?s\s+next\b|read\s+more\b|related\s+(?:posts?|articles?|reading)\b|further\s+reading\b|references\b|sources\b|disclaimer\b|about\s+the\s+author\b|how\s+we\s+can\s+help\b|contact\s+us\b|get\s+in\s+touch\b)/i;

/**
 * An article is at least this long. Anything shorter that a splitter produced
 * is folded back into its neighbour rather than published as a post of its own
 * — a 200-character "article" is an FAQ answer or a pull quote that a boundary
 * detector cut in the wrong place.
 */
const MIN_ARTICLE_CHARS = 500;

/**
 * A line that is nothing but a horizontal rule: `---`, `***`, `___`, `===`,
 * `* * *`. Only counts as a separator when a blank line precedes it, because
 * `---` directly under a line of text is a Markdown setext H2 underline, not a
 * rule — splitting there would cut an article at one of its own headings.
 */
const SEPARATOR_RULE = /^\s*(?:-{3,}|={3,}|\*{3,}|_{3,}|~{3,}|(?:[-*=~_]\s){2,}[-*=~_])\s*$/;

/**
 * A line the admin typed ON PURPOSE to end one blog and start the next:
 * "END OF BLOG", "--- START BLOG ---", "[New Article]", "## Blog Break",
 * "<!-- blog break -->". This is the documented, unambiguous way to control
 * the split, so when one of these is present NOTHING else gets a vote — not
 * the headings, not Gemini.
 */
const SEPARATOR_WORD =
  /^\s*(?:<!--)?\s*[[({]?\s*[-*=~_«»]*\s*(?:#{1,6}\s*)?\**\s*(?:(?:start|starts|begin|begins|end|ends|new|next)\s+(?:of\s+)?(?:the\s+)?(?:blog|article|post)(?:\s+post)?|(?:blog|article|post)(?:\s+post)?\s+(?:start|starts|begin|begins|end|ends|break|divider|separator|split)|blog\s*break)\s*#?\s*\d*\s*\**\s*[-*=~_«»]*\s*[\])}]?\s*(?:-->)?\s*(?:[:.\-–—!]\s*(.*?))?\s*$/i;

/**
 * The same idea for a SERIES of posts: "Start of the series", "Continue the
 * series", "Continue with series", "Next in the series", "In this series",
 * "Series break". A firm publishing a three-part series marks the parts this
 * way rather than typing "END OF BLOG", so these split a document exactly as
 * SEPARATOR_WORD does — they are an ADDITION to it, nothing was removed.
 *
 * NOTE the reversal this represents: "Continue the Series" used to sit in
 * INTERNAL_SUBHEADING, i.e. it was proof that a document was ONE post. It is
 * now proof of the opposite. Nothing may appear in both lists.
 *
 * The whole line has to be the marker, which is what keeps this safe: a
 * sentence opening "In this series, we look at…" does not match, because of
 * the text that follows it. Anything after a `:` or a dash IS taken as the
 * next post's title — "Continue the series: Title Insurance" both cuts the
 * document and names the post that follows.
 */
const SEPARATOR_SERIES =
  /^\s*(?:<!--)?\s*[[({]?\s*[-*=~_«»]*\s*(?:#{1,6}\s*)?\**\s*(?:(?:start|starts|starting|begin|begins|beginning|continue|continues|continuing|continued|next|new)\s+(?:of\s+|with\s+|in\s+|to\s+)?(?:the\s+)?series|(?:in\s+)?this\s+series|series\s+(?:start|starts|begin|begins|continue|continues|continued|end|ends|break|divider|separator|split))\s*\d*\s*\**\s*[-*=~_«»]*\s*[\])}]?\s*(?:-->)?\s*(?:[:.\-–—!]\s*(.*?))?\s*$/i;

/**
 * Whether a line is a worded separator, and the title the admin wrote on it.
 * The single place both separator families are recognised, so explicitSplit(),
 * stripSeparatorLines() and titleFromSection() can never drift apart.
 */
function separatorMatch(line: string): { title: string | null } | null {
  if (!line.trim()) return null;
  const series = line.match(SEPARATOR_SERIES);
  if (series) return { title: (series[1] ?? "").trim() || null };
  const word = line.match(SEPARATOR_WORD);
  if (word) return { title: (word[1] ?? "").trim() || null };
  return null;
}

/**
 * A numbered article label — "Blog 1: Closing Costs", "Article 2.", "Post #3".
 * The text after the number, when there is any, is that article's title.
 */
const ARTICLE_LABEL =
  /^\s*(?:#{1,6}\s+)?\**\s*(?:blog|article|post)(?:\s+post)?\s*#?\s*(\d+)\s*\**\s*(?:[:.)\-–—]\s*(.+?))?\s*\**\s*$/i;

type RawSection = { text: string; title: string | null };
type HeadingLine = { level: number; text: string; offset: number; lineLength: number };

/** Every Markdown heading in the text, with the character offset of its line. */
function headingLines(text: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2], offset, lineLength: line.length });
    offset += line.length + 1;
  }
  return out;
}

/**
 * The document's MAIN heading level and the headings sitting at it — the only
 * level an article boundary is ever allowed to land on.
 *
 * Returns null when no split may happen on headings at all: either the
 * document has no headings, or its shallowest level is a section level
 * (INTERNAL_SUBHEADING). "Main heading, not subheading" is exactly this: a
 * `###` inside an article can never be a boundary while an `##` exists above
 * it, because the shallowest level wins and everything deeper is interior.
 */
function mainHeadings(text: string): { level: number; headings: HeadingLine[] } | null {
  const all = headingLines(text);
  if (all.length === 0) return null;
  const level = Math.min(...all.map((h) => h.level));
  const headings = all.filter((h) => h.level === level);
  if (headings.some((h) => INTERNAL_SUBHEADING.test(h.text))) return null;
  return { level, headings };
}

/** Cuts the text at the given ascending offsets (0 is always the first cut). */
function sliceAtOffsets(text: string, offsets: number[]): string[] {
  const cuts = Array.from(new Set([0, ...offsets])).sort((a, b) => a - b);
  return cuts.map((start, i) => text.slice(start, i + 1 < cuts.length ? cuts[i + 1] : text.length));
}

/**
 * Drops leftover separator lines so they never reach the published body. A
 * rule is only dropped where explicitSplit() would have treated it as one —
 * after a blank line — so a setext heading keeps its underline.
 */
function stripSeparatorLines(s: string): string {
  const lines = s.split("\n");
  return lines
    .filter((line, i) => {
      if (!line.trim()) return true;
      if (separatorMatch(line)) return false;
      const prevBlank = i === 0 || lines[i - 1].trim().length === 0;
      return !(prevBlank && SEPARATOR_RULE.test(line));
    })
    .join("\n");
}

/**
 * Takes the section's own opening heading (or "Blog 2: …" label) as its title
 * and REMOVES that line from the body — the page renders the title above the
 * article, and the format prompt is told not to repeat it, so leaving it in
 * produced either a duplicate heading or a words-dropped warning.
 */
function titleFromSection(raw: string): RawSection {
  const lines = raw.split("\n");
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { text: "", title: null };

  const first = lines[firstIdx].trim();

  // A section begins AT its separator line, so that line is here. Drop it, and
  // keep the title the admin wrote on it ("Continue the series: Part Two"). If
  // there was none, the post's own heading on the next line supplies it.
  const separator = separatorMatch(first);
  if (separator) {
    lines.splice(firstIdx, 1);
    const rest = normaliseBlankLines(lines.join("\n"));
    return separator.title ? { text: rest, title: separator.title } : titleFromSection(rest);
  }

  const heading = first.match(/^#{1,6}\s+(.+?)\s*$/);
  if (heading) {
    lines.splice(firstIdx, 1);
    return { text: normaliseBlankLines(lines.join("\n")), title: heading[1].trim() || null };
  }

  const label = first.match(ARTICLE_LABEL);
  if (label) {
    const inline = (label[2] ?? "").trim();
    if (inline) {
      lines.splice(firstIdx, 1);
      return { text: normaliseBlankLines(lines.join("\n")), title: inline };
    }
    // "Blog 2" on its own line: the real title is the next non-blank line.
    const nextIdx = lines.findIndex((l, i) => i > firstIdx && l.trim().length > 0);
    const next = nextIdx === -1 ? "" : lines[nextIdx].trim().replace(/^#{1,6}\s+/, "");
    if (next && next.length <= 120) {
      lines.splice(nextIdx, 1);
      lines.splice(firstIdx, 1);
      return { text: normaliseBlankLines(lines.join("\n")), title: next };
    }
    lines.splice(firstIdx, 1);
    return { text: normaliseBlankLines(lines.join("\n")), title: null };
  }

  return { text: normaliseBlankLines(raw), title: null };
}

/**
 * Folds any section below MIN_ARTICLE_CHARS into its neighbour. Whatever cut
 * it out — Gemini or a heading rule — cut in the wrong place, and re-joining
 * is the only move that cannot lose the author's words.
 */
function mergeRunts(sections: RawSection[]): RawSection[] {
  if (sections.length <= 1) return sections;

  const out: RawSection[] = [];
  for (const section of sections) {
    const prev = out[out.length - 1];
    if (prev && section.text.length < MIN_ARTICLE_CHARS) {
      prev.text = normaliseBlankLines(
        `${prev.text}\n\n${section.title ? `## ${section.title}\n\n` : ""}${section.text}`,
      );
      continue;
    }
    out.push({ ...section });
  }

  // A short FIRST section has no previous to fold into; fold it forwards.
  while (out.length > 1 && out[0].text.length < MIN_ARTICLE_CHARS) {
    const [first, second] = out;
    out.splice(0, 2, {
      title: first.title ?? second.title,
      text: normaliseBlankLines(
        `${first.text}\n\n${second.title ? `## ${second.title}\n\n` : ""}${second.text}`,
      ),
    });
  }
  return out;
}

/**
 * Order matters here: titleFromSection() runs FIRST, because a section begins
 * at its own separator line and that line may carry the post's title
 * ("Continue the series: Part Two"). Stripping separators first would throw
 * the title away. Whatever separators are left inside the body are removed
 * afterwards.
 */
function finishSections(chunks: string[]): RawSection[] {
  return mergeRunts(
    chunks
      .map((c) => {
        const section = titleFromSection(normaliseBlankLines(c));
        return { ...section, text: normaliseBlankLines(stripSeparatorLines(section.text)) };
      })
      .filter((s) => s.text.trim().length > 0),
  );
}

/**
 * The split the admin asked for in the document itself. Returns null when the
 * document carries no explicit instruction.
 *
 * Precedence, most explicit first: numbered labels (they carry titles too),
 * then worded markers, then horizontal rules.
 */
function explicitSplit(text: string): { sections: RawSection[]; reason: string } | null {
  const lines = text.split("\n");
  const labelAt: number[] = [];
  const wordAt: number[] = [];
  const ruleAt: number[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prevBlank = i === 0 || lines[i - 1].trim().length === 0;
    if (line.trim()) {
      if (ARTICLE_LABEL.test(line)) labelAt.push(offset);
      else if (separatorMatch(line)) wordAt.push(offset);
      // A rule directly under text is a setext heading underline, not a rule.
      else if (prevBlank && SEPARATOR_RULE.test(line)) ruleAt.push(offset);
    }
    offset += line.length + 1;
  }

  let offsets: number[];
  let reason: string;
  if (labelAt.length >= 2) {
    offsets = labelAt;
    reason = 'numbered "Blog N:" labels';
  } else if (wordAt.length >= 1) {
    // A marker ends the block before it and starts the one after it; cutting at
    // the marker line and dropping the line itself handles both "END OF BLOG"
    // and "START BLOG" without having to know which the admin typed.
    offsets = wordAt;
    reason = "start/end blog markers";
  } else if (ruleAt.length >= 1) {
    offsets = ruleAt;
    reason = "horizontal-rule separators";
  } else {
    return null;
  }

  const sections = finishSections(sliceAtOffsets(text, offsets));
  if (sections.length < 2) return null;
  return { sections, reason };
}

/**
 * Heading-based split — the last resort, and deliberately the narrowest.
 *
 * Only `#` (a Word "Heading 1" / Markdown h1 / a PDF's "# ") counts. That is
 * the author's MAIN heading: the level a standalone post's headline sits at.
 * `##` and below are how one article organises itself, and splitting there is
 * precisely the bug this guard exists to prevent — so when the shallowest
 * heading in the document is `##`, this returns null and the document stays a
 * single post.
 */
function headingSplit(text: string): { sections: RawSection[]; reason: string } | null {
  const main = mainHeadings(text);
  if (!main || main.level !== 1) return null;

  const sections = finishSections(sliceAtOffsets(text, main.headings.map((h) => h.offset)));
  if (sections.length < 2) return null;
  return { sections, reason: "top-level (#) headings" };
}

type BoundaryMarker = { title: string; startSnippet: string; suggestedTags: string[] };

const BOUNDARY_PROMPT = (text: string) => `You are an expert editorial assistant. Analyze the document below, which may contain ONE or MULTIPLE separate blog posts/articles.
Your job is to identify each complete, standalone blog article and detect its boundaries.

CRITICAL RULES:
1. ONE ARTICLE IS THE DEFAULT. Most documents contain exactly one article. Report more than one ONLY when the document plainly contains several unrelated, standalone posts, each with its own headline, its own beginning and its own end.
2. SUBHEADINGS ARE NOT ARTICLES:
   - Internal sections such as "Introduction", "1. Land Transfer Tax", "Key Takeaways", "Conclusion", "Final Thoughts", "FAQ", "Frequently Asked Questions", "Continue the Series", "Related Reading" are INTERNAL SUBHEADINGS of ONE article. NEVER split at them.
   - A heading that carries on the same subject as the text above it is a subheading, not a new article.
   - Only the document's MAIN (shallowest) heading level can begin an article. Headings nested under a bigger heading are subheadings.
3. PRESERVE THE AUTHOR'S WORDS: to identify a boundary, return the exact starting text snippet of each article — copied character for character from the document, 40 to 80 characters long, starting at that article's own heading line. Never paraphrase the snippet.
4. For each detected article, return:
   - "title": clean title/headline of the article
   - "startSnippet": the exact first 40 to 80 verbatim characters of where this article begins
   - "suggestedTags": 2 to 4 relevant tags
5. If the document is really just one article, return an array with exactly one item, whose startSnippet is the document's own opening words.

Return JSON of exactly this shape, and nothing else:
[
  { "title": "Article Title", "startSnippet": "First 40-80 verbatim characters...", "suggestedTags": ["Tag1", "Tag2"] }
]

--- DOCUMENT BEGINS ---
${text}
--- DOCUMENT ENDS ---`;

function parseBoundaryJson(raw: string): BoundaryMarker[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Model did not return an array.");
  return parsed
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        title: typeof o.title === "string" ? o.title.trim() : "",
        startSnippet: typeof o.startSnippet === "string" ? o.startSnippet : "",
        suggestedTags: Array.isArray(o.suggestedTags)
          ? o.suggestedTags.filter((t): t is string => typeof t === "string").slice(0, 4)
          : [],
      };
    })
    .filter((m) => m.startSnippet.trim().length > 0);
}

/**
 * Asks Gemini where each standalone article starts. Returns null (never
 * throws) on any failure — missing key, every rung down, or an answer with no
 * usable snippets — so the caller can fall back to the deterministic splitter
 * without the whole import failing over an AI boundary call.
 */
async function aiSeparateArticles(text: string): Promise<BoundaryMarker[] | null> {
  if (!geminiApiKey()) return null;
  if (text.length < 200) return null;

  const result = await callGeminiJson<BoundaryMarker[]>({
    prompt: BOUNDARY_PROMPT(text),
    parse: parseBoundaryJson,
    label: "blogImportBoundaries",
    ladder: BLOG_MODEL_LADDER,
    // ~100 tokens per article marker. With no cap on articles per document,
    // 4000 truncated the JSON past ~40 articles and silently dropped to the
    // heading-based fallback splitter.
    maxOutputTokens: 16000,
  });

  if (!result.ok || result.data.length === 0) return null;
  return result.data;
}

/**
 * Where a marker's snippet actually is in the document — verbatim `indexOf`,
 * no fuzzy matching, because a wrong guess misplaces a whole article's worth
 * of text — SNAPPED back to the main heading it belongs to, then CHECKED
 * against the document's own structure.
 *
 * A marker survives only if it lands on the document's main heading level (or
 * at offset 0). Everything else is discarded, and that is what stops the model
 * turning "### FAQ" or a mid-article subheading into a blog post of its own.
 * When the document has no headings at all there is nothing to check against,
 * so a boundary is accepted anywhere and MIN_ARTICLE_CHARS is left to catch
 * the over-eager cuts.
 */
function locateMarkers(text: string, markers: BoundaryMarker[]): number[] {
  const topLevel = mainHeadings(text);
  // Only `#` begins an article. A document whose shallowest heading is `##` is
  // a single article with sections, and Gemini does not get to overrule that —
  // this is the guard the "one blog, many sections" bug kept getting past.
  const main = topLevel && topLevel.level === 1 ? topLevel : null;
  const hasHeadings = headingLines(text).length > 0;
  const headingAt = new Set(main ? main.headings.map((h) => h.offset) : []);

  const found: number[] = [];
  const used = new Set<number>();

  for (const marker of markers) {
    const snippet = marker.startSnippet.trim();
    if (!snippet) continue;
    // The same opening words can occur twice (an article pasted twice); take
    // the next unclaimed occurrence so the repeat is flagged as a duplicate
    // rather than folded into the previous article's body.
    let idx = text.indexOf(snippet);
    while (idx !== -1 && used.has(idx)) idx = text.indexOf(snippet, idx + 1);
    if (idx === -1) continue;
    used.add(idx);

    // Snap to the start of the marker's own line, then back over a heading the
    // snippet began just after.
    let lineStart = idx === 0 ? 0 : text.lastIndexOf("\n", idx - 1) + 1;
    if (main && !headingAt.has(lineStart)) {
      const owner = main.headings
        .filter((h) => h.offset <= lineStart && lineStart - (h.offset + h.lineLength) <= 2)
        .pop();
      if (owner) lineStart = owner.offset;
    }

    if (lineStart !== 0) {
      // Main level is a section level (or there is no usable main level at all
      // while headings exist) → the document is one article; drop the cut.
      if (!main && hasHeadings) continue;
      if (main && !headingAt.has(lineStart)) continue; // a subheading or mid-article cut
    }

    found.push(lineStart);
  }

  return Array.from(new Set(found)).sort((a, b) => a - b);
}

/** The article's opening line, when that line is a heading (`#`–`######`). */
function leadingHeading(chunk: string): string | null {
  const first = chunk.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const m = first.match(/^#{1,6}\s+(.+)$/);
  return m ? m[1].trim() : null;
}

/** A title sniffed from an article's own opening lines, when nothing else supplied one. */
function sniffTitle(articleText: string): string | null {
  const lines = articleText.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) return heading[1].trim();
    if (trimmed.length < 100 && !/^(the|a|an|and|or|but|in|on|at)\s/i.test(trimmed)) {
      return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
    }
    break;
  }
  return null;
}

/**
 * `#` never reaches the stored article body: the page owns the only h1, the
 * sanitizer's allowlist has no h1 in it, and a formatter that emitted one
 * would have that text dropped entirely. The marker exists so the splitter can
 * tell a main heading from a subheading; once the cut is made it is demoted.
 */
function demoteTopHeadings(text: string): string {
  return text.replace(/^(\s*)#\s+(?=\S)/gm, "$1## ");
}

export type SplitOutcome = { sections: RawSection[]; reason: string };

/**
 * Where a document becomes one-or-more articles. Exported so the split can be
 * exercised on its own, without a file or a Gemini key.
 *
 * Precedence — the most explicit signal wins, and every tier is allowed to
 * answer "one article", which is always the safe answer:
 *   1. What the admin wrote in the document: "Blog 2:", "END OF BLOG", `---`.
 *      Authoritative; Gemini is not consulted at all.
 *   2. Gemini's boundaries, but only where they land on the document's MAIN
 *      heading level (locateMarkers).
 *   3. `#` main headings on our own, for when Gemini is off or unhelpful.
 *   4. One article.
 */
export function splitBlogDocument(text: string, aiMarkers: BoundaryMarker[] | null): SplitOutcome {
  const explicit = explicitSplit(text);
  if (explicit) return explicit;

  if (aiMarkers) {
    const offsets = locateMarkers(text, aiMarkers);
    if (offsets.length > 1) {
      const sections = finishSections(sliceAtOffsets(text, offsets));
      if (sections.length > 1) return { sections, reason: "AI boundaries at main headings" };
    }
  }

  const headings = headingSplit(text);
  if (headings) return headings;

  return { sections: finishSections([text]), reason: "single article" };
}

// ── Entry point ────────────────────────────────────────────────────────

/**
 * File-level validation plus kind-based extraction, with NO total-character
 * cap. Shared by both entry points below; each applies its own cap on top —
 * the single-article path's MAX_EXTRACTED_CHARS, the multi-article path's
 * per-article MAX_BLOG_CHARS (a warning, not a rejection).
 */
async function extractRaw(file: File): Promise<ExtractOutcome> {
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

  if (outcome.data.text.trim().length === 0) {
    return { ok: false, error: `No article text could be read out of ${file.name}.` };
  }

  return outcome;
}

export async function extractBlogArticle(file: File): Promise<ExtractOutcome> {
  const outcome = await extractRaw(file);
  if (!outcome.ok) return outcome;

  const { text } = outcome.data;
  if (text.length > MAX_BLOG_CHARS) {
    return {
      ok: false,
      error: `${file.name} came to ${text.length.toLocaleString()} characters; the limit is ${MAX_BLOG_CHARS.toLocaleString()}. Split it into shorter posts.`,
    };
  }

  // A title taken from the document is only a suggestion; the route decides
  // whether to apply it, because the admin may already have typed one.
  // `#` is demoted here for the same reason the multi-article path demotes it:
  // nothing below this point splits anything, and h1 is not an allowed tag in
  // an article body.
  return { ok: true, data: { ...outcome.data, text: demoteTopHeadings(text) } };
}

/**
 * Extracts one or more blog articles from a single uploaded file.
 *
 * ONE ARTICLE IS THE DEFAULT. A document only becomes several posts when
 * something in it actually says so — see splitBlogDocument() for the
 * precedence. The splitter that used to run here cut at every `#`/`##` line
 * that was not on a small denylist, which shredded a single well-structured
 * article into one post per section; boundaries are now confined to the
 * document's own MAIN heading level, or to an explicit separator the admin
 * typed.
 *
 * No cap on the number of articles or on the total length: a document can hold
 * any number of articles whose combined length runs well past any single
 * article's own limit. Each article gets its own MAX_BLOG_CHARS check below,
 * which WARNS rather than truncates or rejects.
 */
export async function extractMultipleBlogArticles(file: File): Promise<MultipleExtractOutcome> {
  // Preformatted HTML already carries its own structure; splitting it the same
  // way as plain text would mean regexing markup, which is how a table gets
  // shredded. Treat an HTML upload as exactly one article, as the single-file
  // path already does.
  if (importKindFor(file.name) === "html") {
    const singleExtraction = await extractBlogArticle(file);
    if (!singleExtraction.ok) return singleExtraction;
    return { ok: true, data: [singleExtraction.data] };
  }

  const extraction = await extractRaw(file);
  if (!extraction.ok) return extraction;

  const { text, kind, needsProofread, warnings: fileWarnings, title: documentTitle } = extraction.data;

  // Gemini is only consulted when the document carries no explicit separator;
  // asking it anyway would cost a call whose answer is thrown away.
  const aiMarkers = explicitSplit(text) ? null : await aiSeparateArticles(text);
  const { sections, reason } = splitBlogDocument(text, aiMarkers);

  if (sections.length === 0) {
    return { ok: false, error: "No article text found in the document." };
  }

  // Extraction lifts the document's first heading OUT of the text as its title,
  // so the first article no longer opens with a heading of its own and would
  // otherwise get the model's paraphrase — which the duplicate check keys on.
  if (documentTitle && sections[0] && !sections[0].title) {
    sections[0] = { ...sections[0], title: documentTitle };
  }

  logger.info(
    `[blogImport] ${file.name} → ${sections.length} article(s), split on: ${reason}` +
      (aiMarkers ? ` (Gemini proposed ${aiMarkers.length})` : ""),
  );

  const results: ExtractedArticle[] = sections.map(({ text: sectionText, title }) => {
    const articleText = demoteTopHeadings(sectionText);
    const warnings = [...fileWarnings];
    if (articleText.length > MAX_BLOG_CHARS) {
      warnings.push(
        `This article is ${articleText.length.toLocaleString()} characters, above the ${MAX_BLOG_CHARS.toLocaleString()}-character guideline. Nothing was cut — review it before publishing.`,
      );
    }
    return {
      text: articleText,
      title: title ?? leadingHeading(articleText) ?? sniffTitle(articleText),
      preformattedHtml: null,
      kind,
      warnings,
      needsProofread,
    };
  });

  return { ok: true, data: results };
}
