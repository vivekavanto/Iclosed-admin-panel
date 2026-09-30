import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { createPost, listTitlesAndSlugs, slugify } from "@/lib/blogPosts";
import { recordAudit } from "@/lib/recordAudit";
import {
  extractBlogArticle,
  extractMultipleBlogArticles,
  MAX_IMPORT_BYTES,
  MAX_BLOG_CHARS,
  IMPORT_LABEL,
} from "@/lib/blogImport";
import { formatBlogHtml } from "@/lib/blogFormat";
import { generateBlogSeo } from "@/lib/blogSeo";
import { logger } from "@/lib/logger";
import { readBlobDocument, BlobDocumentError } from "@/lib/blobDocument";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";
import { del } from "@vercel/blob";

/**
 * Flags a detected article as a likely re-upload: same slug as an existing
 * post, or the same title as another article already seen earlier in THIS
 * batch (two sections of the same document that both look like standalone
 * posts). Non-blocking — the admin decides whether it's really a duplicate.
 */
function findDuplicateTitle(
  title: string,
  existingSlugs: Set<string>,
  seenInBatch: Set<string>,
): boolean {
  const slug = slugify(title || "untitled");
  if (existingSlugs.has(slug)) return true;
  if (seenInBatch.has(slug)) return true;
  seenInBatch.add(slug);
  return false;
}

/**
 * POST /api/admin/blog/import — upload a document, get back a whole draft post.
 *
 * application/json (the browser's normal path — see MultiBlogUpload in
 * Blogs.tsx): { blobUrl, fileName, title?, multiple?, extractOnly?, createDrafts? }
 *   blobUrl is a Vercel Blob URL the browser already uploaded to via
 *   /api/admin/blog/import/token, so a document up to MAX_IMPORT_BYTES (20 MB)
 *   never has to pass through this function's ~4.5 MB body limit. The blob is
 *   read back with readBlobDocument() and deleted once its bytes are in memory
 *   — it is scratch storage for the import, not a document this app keeps.
 *
 * multipart/form-data (legacy / any caller that has the bytes in hand and is
 * comfortable with the ~4.5 MB platform ceiling):
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
  let importMultiple = false;
  let createDrafts = false;
  let extractOnly = false;

  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body." }, { status: 400 });
    }

    const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : null;
    if (!blobUrl || !isBlobUrl(blobUrl)) {
      return NextResponse.json(
        { success: false, error: "Missing or invalid upload — the document did not reach storage." },
        { status: 400 },
      );
    }

    const fileName = typeof body.fileName === "string" && body.fileName.trim() ? body.fileName.trim() : "upload";
    typedTitle = typeof body.title === "string" ? body.title.trim() : "";
    importMultiple = body.multiple === true;
    createDrafts = body.createDrafts === true;
    extractOnly = body.extractOnly === true;

    try {
      const { bytes, meta } = await readBlobDocument(blobUrl, MAX_IMPORT_BYTES);
      file = new File([new Uint8Array(bytes)], fileName, { type: meta.contentType });
    } catch (err) {
      const status = err instanceof BlobDocumentError ? err.status : 400;
      const message = err instanceof Error ? err.message : "Could not read the uploaded file.";
      return NextResponse.json({ success: false, error: message }, { status });
    } finally {
      // Best-effort: this blob is scratch storage for the import, not a kept
      // document. Its bytes are already in `file` at this point, so a failed
      // delete just leaves one orphaned blob rather than breaking the import.
      del(blobUrl, { token: blobTokenForUrl(blobUrl) }).catch((err) => {
        logger.warn(
          `[blogImport] could not delete import blob: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  } else {
    try {
      const form = await req.formData();
      file = form.get("file") as File | null;
      const t = form.get("title");
      typedTitle = typeof t === "string" ? t.trim() : "";
      const m = form.get("multiple");
      importMultiple = m === "true" || m === "1";
      const c = form.get("createDrafts");
      createDrafts = c === "true" || c === "1";
      const eo = form.get("extractOnly");
      extractOnly = eo === "true" || eo === "1";
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: `Could not read the upload. The file must be ${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)} MB or smaller.`,
        },
        { status: 400 },
      );
    }
  }

  if (!file) {
    return NextResponse.json(
      { success: false, error: `Choose a ${IMPORT_LABEL} file to upload.` },
      { status: 400 },
    );
  }

  // Handle multiple articles extraction
  if (importMultiple) {
    const extracted = await extractMultipleBlogArticles(file);
    if (!extracted.ok) {
      return NextResponse.json({ success: false, error: extracted.error }, { status: 400 });
    }

    const articles = extracted.data;

    // extractOnly skips both Gemini steps: the popup that drives this needs to
    // show "N blogs found" fast, before the admin has decided anything is worth
    // formatting. Format/SEO still run, just later and in parallel across every
    // article at once (BlogBatchManager's "Format All"), which is what actually
    // keeps the total wait down — not doing it inline, one article at a time,
    // during the extraction request.
    if (extractOnly) {
      const existingSlugs = new Set((await listTitlesAndSlugs()).map((p) => p.slug.toLowerCase()));
      const seenInBatch = new Set<string>();

      logger.info(
        `[blogImport] ${articles[0]?.kind} ${file.name} — ${articles.length} articles extracted (extractOnly)`,
      );
      return NextResponse.json({
        success: true,
        isMultiple: true,
        articleCount: articles.length,
        maxBlogChars: MAX_BLOG_CHARS,
        fileName: file.name,
        articles: articles.map((a) => {
          const title = a.title || "";
          const charCount = a.text.length;
          const isDuplicate = findDuplicateTitle(title, existingSlugs, seenInBatch);
          return {
            title,
            text: a.text,
            html: a.preformattedHtml ?? "",
            formatSource: a.preformattedHtml ? "manual" : ("manual" as const),
            formatModel: null,
            wordsPreserved: null,
            needsProofread: a.needsProofread,
            seo: null,
            warnings: [...a.warnings],
            charCount,
            isDuplicate,
            validationStatus: charCount > MAX_BLOG_CHARS ? "warning" : "ready",
          };
        }),
      });
    }

    const results = [];

    for (const article of articles) {
      const { text, title: fileTitle, preformattedHtml, kind, needsProofread } = article;
      const title = fileTitle || "";
      const warnings: string[] = [...article.warnings];

      const [formatted, seo] = await Promise.all([
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

      results.push({
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

    logger.info(
      `[blogImport] ${extracted.data[0]?.kind} ${file.name} — ${articles.length} articles extracted`,
    );

    // Auto-create drafts if requested from the listing page
    if (createDrafts) {
      const batchId = crypto.randomUUID();
      const createdIds: string[] = [];

      for (const blog of results) {
        const title = blog.title?.trim() || "Untitled";
        const result = await createPost(
          {
            title,
            status: "draft",
            content_html: blog.html,
            content_source: blog.text,
            excerpt: "",
            cover_image_url: null,
            cover_image_alt: null,
            author: "iClosed Real Estate Law Desk",
            tags: [],
            meta_title: (blog.seo as Record<string, unknown>)?.metaTitle as string || null,
            meta_description: (blog.seo as Record<string, unknown>)?.metaDescription as string || null,
            focus_keyword: (blog.seo as Record<string, unknown>)?.focusKeyword as string || null,
            faq: [],
            noindex: false,
            format_source: blog.formatSource,
            seo_source: blog.seo ? "gemini" : "manual",
            import_batch_id: batchId,
          },
          email ?? "import-batch",
        );

        if (result.ok) {
          createdIds.push(result.row.id);
          logger.info(`[blogImport] Created draft: "${result.row.title}" (${result.row.id})`);
        } else {
          logger.error(`[blogImport] Failed to create draft "${blog.title}": ${result.error}`);
        }
      }

      await recordAudit({
        action: "blog.import_batch_create",
        actorEmail: email,
        resourceType: "blog_post_batch",
        resourceId: batchId,
        metadata: { fileName: file.name, articleCount: articles.length, createdCount: createdIds.length },
        req,
      });

      return NextResponse.json({
        success: true,
        isMultiple: true,
        batchId,
        articleCount: articles.length,
        fileName: file.name,
        articlesCreated: createdIds.length,
        articles: results,
        createdIds,
      });
    }

    return NextResponse.json({
      success: true,
      isMultiple: true,
      articleCount: articles.length,
      fileName: file.name,
      articles: results,
    });
  }

  // Handle single article extraction (original behavior)
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
    isMultiple: false,
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
