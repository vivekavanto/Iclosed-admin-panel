import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { extractBlogArticle, MAX_IMPORT_BYTES, IMPORT_LABEL } from "@/lib/blogImport";
import { formatBlogHtml } from "@/lib/blogFormat";
import { generateBlogSeo } from "@/lib/blogSeo";
import { logger } from "@/lib/logger";

/**
 * POST /api/admin/blog/import — upload a document, get back a whole draft post.
 *
 * multipart/form-data:
 *   file   the article (see IMPORT_LABEL for the accepted formats)
 *   title  optional — whatever the admin has already typed into the editor
 *
 * One request does what the two existing buttons do in sequence: extract the
 * author's text (src/lib/blogImport.ts), format it into article HTML
 * (src/lib/blogFormat.ts) and draft the search metadata (src/lib/blogSeo.ts).
 *
 * ── Stateless, like the other two AI routes ─────────────────────────────
 * It writes NOTHING. No row is created, no blob is stored, and an upload that
 * is never saved leaves nothing behind. The admin sees the extracted text, the
 * formatted article and the drafted metadata side by side, and saving is still
 * a separate, explicit POST /api/admin/blog. That matters more here than on
 * the other two routes, not less: an imported post is the case where nobody
 * typed a single one of the words on screen.
 *
 * ── Why format and SEO run in PARALLEL ──────────────────────────────────
 * The editor runs them in order because the admin presses one button, reads
 * the result, then presses the other. Here nobody is reading in between, and
 * the second step does not actually depend on the first: generateBlogSeo()
 * flattens whatever body it is given back to plain text, so feeding it the
 * formatted HTML and feeding it the source text produce the same prompt. Doing
 * them at once halves the worst-case wait rather than stacking two ladders.
 *
 * ── Partial success is a success ────────────────────────────────────────
 * Once the text is out of the file, the expensive and failure-prone part is
 * done. If Gemini is unavailable for the formatting or the metadata, this
 * still returns the extracted text with a warning saying which step to retry —
 * throwing that away and making the admin re-upload would be worse than the
 * failure it is reporting.
 */

// jszip, sanitize-html and Buffer all need Node, not Edge.
export const runtime = "nodejs";

// Worst case is a PDF: transcription (60s + 40s down the file ladder) and then
// format and SEO together (30s + 20s down the text ladder). The two rungs of a
// single step almost never both run, but the ceiling has to cover it — without
// it the platform default cuts the request off and returns a gateway HTML 504
// the editor cannot parse.
export const maxDuration = 180;

export async function POST(req: Request) {
  const { email } = await getActingAdmin();

  // Tighter than the 40/minute the format and SEO routes allow: one import is
  // up to three Gemini calls, and it is driven by a file picker rather than a
  // button, so there is no plausible reason to run more than a few a minute.
  const allowed = await rateLimitOk(`blog-import:${email ?? "unknown"}`, 12, 60);
  if (!allowed) {
    return NextResponse.json(
      { success: false, error: "Too many uploads. Wait a minute and try again." },
      { status: 429 },
    );
  }

  let file: File | null = null;
  let typedTitle = "";
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
    const t = form.get("title");
    typedTitle = typeof t === "string" ? t.trim() : "";
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: `Could not read the upload. The file must be ${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)} MB or smaller.`,
      },
      { status: 400 },
    );
  }

  if (!file) {
    return NextResponse.json(
      { success: false, error: `Choose a ${IMPORT_LABEL} file to upload.` },
      { status: 400 },
    );
  }

  const extracted = await extractBlogArticle(file);
  if (!extracted.ok) {
    return NextResponse.json({ success: false, error: extracted.error }, { status: 400 });
  }

  const { text, title: fileTitle, preformattedHtml, kind, needsProofread } = extracted.data;

  // A title the admin typed wins: they were looking at the editor when they
  // typed it, and the one in the file may well be a filename-ish placeholder.
  const title = typedTitle || fileTitle || "";

  const warnings = [...extracted.data.warnings];

  const [formatted, seo] = await Promise.all([
    // An HTML upload already carries its structure, so re-formatting it would
    // only risk losing the links and tables that survived sanitizing.
    preformattedHtml ? null : formatBlogHtml({ body: text, title: title || undefined }),
    generateBlogSeo({ title, body: text }),
  ]);

  let html = preformattedHtml ?? "";
  let formatSource: "manual" | "gemini" = preformattedHtml ? "manual" : "gemini";
  let wordsPreserved: number | null = null;
  let formatModel: string | null = null;

  if (formatted) {
    if (formatted.ok) {
      html = formatted.data.html;
      wordsPreserved = formatted.data.wordsPreserved;
      formatModel = formatted.data.model;
      warnings.push(...formatted.data.warnings);
    } else {
      // The text is still good; only the markup step failed.
      formatSource = "manual";
      warnings.push(
        `The article text was imported, but formatting it failed: ${formatted.error} Press "Format with AI" to retry.`,
      );
    }
  }

  const seoFields = seo.ok ? seo.data : null;
  if (seo.ok) {
    warnings.push(...seo.data.warnings);
  } else {
    warnings.push(
      `The article text was imported, but the search metadata could not be drafted: ${seo.error} Press "Format with AI" to retry.`,
    );
  }

  logger.info(
    `[blogImport] ${kind} ${file.name} — ${text.length}ch, format=${formatted ? (formatted.ok ? "ok" : "failed") : "skipped"}, seo=${seo.ok ? "ok" : "failed"}`,
  );

  return NextResponse.json({
    success: true,
    kind,
    fileName: file.name,
    title,
    text,
    html,
    formatSource,
    formatModel,
    wordsPreserved,
    needsProofread,
    seo: seoFields,
    warnings,
  });
}
