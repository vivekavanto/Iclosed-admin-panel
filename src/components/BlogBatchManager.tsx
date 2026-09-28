"use client";

import React, { useState } from "react";
import { Loader2, Sparkles, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";

export type ManagedBlog = {
  title: string;
  text: string;
  html: string;
  formatSource: "manual" | "gemini";
  formatModel?: string;
  wordsPreserved?: number;
  needsProofread: boolean;
  seo?: Record<string, unknown> | null;
  warnings: string[];
  isFormatting?: boolean;
  isExpanded?: boolean;
  /** Set by the last formatting attempt, so a retry knows which half failed. */
  formatFailed?: boolean;
  seoFailed?: boolean;
  /** From the import route: this article's own character count. */
  charCount?: number;
  /** Its title/slug matched an existing post, or another article in this batch. */
  isDuplicate?: boolean;
  /** "warning" = over the per-article character guideline. Never truncated. */
  validationStatus?: "ready" | "warning";
  /** Generated cover image, same field POST /api/admin/blog writes to cover_image_url. */
  coverImageUrl?: string;
  coverImageAlt?: string;
  isGeneratingImage?: boolean;
  /** Set by the last image attempt. Never blocks Save/Publish — a cover image is optional. */
  imageFailed?: boolean;
};

/** An article that should be kept as a draft rather than auto-published. */
export function needsReview(blog: ManagedBlog): boolean {
  return blog.validationStatus === "warning" || Boolean(blog.isDuplicate);
}

interface BlogBatchManagerProps {
  blogs: ManagedBlog[];
  onBlogsChange: (blogs: ManagedBlog[]) => void;
  /** `publish` picks which action fired: Save All as Drafts vs Publish All. */
  onCreateAll: (publish: boolean) => Promise<void>;
  isCreating: boolean;
  /** Which action is in flight, for the button label. */
  creatingMode?: "draft" | "publish" | null;
}

/** An HTML upload already carries its own markup — only its metadata is missing. */
function needsFormatting(blog: ManagedBlog): boolean {
  return blog.formatSource !== "gemini" && !blog.html.trim();
}

function needsSeo(blog: ManagedBlog): boolean {
  return !blog.seo;
}

/**
 * Same 200-character floor BlogEditor's own "Generate image" button enforces
 * client-side — below that there usually isn't enough content for a sensible
 * prompt, so this is treated as "not applicable" rather than a failure: no
 * warning, no retry offered, and it never blocks Save/Publish.
 */
function needsImage(blog: ManagedBlog): boolean {
  // Not gated on imageFailed: an earlier failure doesn't set coverImageUrl
  // either, so this stays true until an attempt actually succeeds — same
  // shape as needsFormatting/needsSeo, and what lets "Format All" or the
  // dedicated Retry button pick a failed image back up.
  return blog.title.trim().length > 0 && blog.text.trim().length >= 200 && !blog.coverImageUrl;
}

/**
 * Runs `worker` over every item, at most `limit` in flight at once.
 *
 * Formatting 10 articles by firing all 20 format+SEO calls at the same instant
 * (the previous behaviour) was what silently produced blank meta titles: a
 * burst that size trips Gemini's own per-project rate limit, a handful of
 * calls come back non-200, and each one just leaves that one blog's SEO
 * fields null with a warning nobody was shown before saving. A small
 * concurrency cap keeps the batch fast without the burst.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lane = async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

const FORMAT_CONCURRENCY = 3;

/** One retry, since a single dropped call in a burst is usually transient. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

export default function BlogBatchManager({
  blogs,
  onBlogsChange,
  onCreateAll,
  isCreating,
  creatingMode,
}: BlogBatchManagerProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(0);
  const [isFormattingAll, setIsFormattingAll] = useState(false);
  const [formatAllProgress, setFormatAllProgress] = useState<{ done: number; total: number } | null>(
    null,
  );

  const toggleExpand = (index: number) => {
    setExpandedIndex(expandedIndex === index ? null : index);
  };

  // Formats one blog in place. Takes the current blog list as an argument
  // (rather than reading `blogs` from closure) so that when several of these
  // run concurrently via Promise.all, each write lands on top of the latest
  // array instead of a stale snapshot captured before the others started.
  const formatOne = async (
    index: number,
    current: ManagedBlog[],
    commit: (updater: (prev: ManagedBlog[]) => ManagedBlog[]) => void,
  ) => {
    const blog = current[index];
    const wantsImage = needsImage(blog);
    commit((prev) =>
      prev.map((b, i) =>
        i === index ? { ...b, isFormatting: true, isGeneratingImage: wantsImage } : b,
      ),
    );

    // Format+SEO and the cover image are independent of each other — the image
    // prompt is built from the article's own title/text, not from the
    // formatted HTML — so they run concurrently rather than one after another.
    // That halves the wait per article instead of stacking three ladders.
    const formatAndSeo = (async () => {
      let html = blog.html;
      let formatSource = blog.formatSource;
      let formatModel = blog.formatModel;
      let wordsPreserved = blog.wordsPreserved;
      const notes = [...blog.warnings];
      let formatFailed = false;
      let seoFailed = false;

      if (needsFormatting(blog)) {
        try {
          const json = await withRetry(async () => {
            const res = await fetch("/api/admin/blog/format", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: blog.text, title: blog.title }),
            });
            const body = await res.json();
            if (!res.ok || !body.success) throw new Error(body.error ?? "Formatting failed");
            return body;
          });
          html = json.html;
          formatSource = "gemini";
          formatModel = json.model;
          wordsPreserved = json.wordsPreserved;
          notes.push(...(json.warnings ?? []));
        } catch (err) {
          formatFailed = true;
          notes.push(err instanceof Error ? err.message : "Formatting failed");
        }
      }

      let seo: Record<string, unknown> | null = blog.seo ?? null;
      if (needsSeo(blog)) {
        try {
          const seoJson = await withRetry(async () => {
            const seoRes = await fetch("/api/admin/blog/seo", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ body: html || blog.text, title: blog.title }),
            });
            const body = await seoRes.json();
            if (!seoRes.ok || !body.success) throw new Error(body.error ?? "Could not draft search metadata");
            return body;
          });
          seo = seoJson.seo;
        } catch (err) {
          seoFailed = true;
          notes.push(err instanceof Error ? err.message : "Could not draft search metadata");
        }
      }

      return { html, formatSource, formatModel, wordsPreserved, notes, seo, formatFailed, seoFailed };
    })();

    const image = wantsImage
      ? (async () => {
          try {
            const json = await withRetry(async () => {
              const res = await fetch("/api/admin/blog/generate-image", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: blog.title, body: blog.text }),
              });
              const body = await res.json();
              if (!res.ok || !body.success) throw new Error(body.error ?? "Image generation failed");
              return body;
            });
            // success:true with imageUrl:null is the route's "rendered but
            // could not be uploaded" case — a real failure, just one that
            // didn't throw, so it needs the same treatment as the catch below.
            return json.imageUrl
              ? { coverImageUrl: json.imageUrl as string, imageFailed: false, imageNote: null as string | null }
              : {
                  coverImageUrl: undefined,
                  imageFailed: true,
                  imageNote: (json.message as string | undefined) ?? "Cover image could not be generated.",
                };
          } catch (err) {
            return {
              coverImageUrl: undefined,
              imageFailed: true,
              imageNote: err instanceof Error ? err.message : "Cover image could not be generated.",
            };
          }
        })()
      : Promise.resolve({
          coverImageUrl: blog.coverImageUrl,
          imageFailed: blog.imageFailed,
          imageNote: null as string | null,
        });

    const [formatSeoResult, imageResult] = await Promise.all([formatAndSeo, image]);
    const warnings = imageResult.imageNote
      ? [...formatSeoResult.notes, imageResult.imageNote]
      : formatSeoResult.notes;

    commit((prev) =>
      prev.map((b, i) =>
        i === index
          ? {
              ...b,
              html: formatSeoResult.html,
              formatSource: formatSeoResult.formatSource,
              formatModel: formatSeoResult.formatModel,
              wordsPreserved: formatSeoResult.wordsPreserved,
              warnings,
              seo: formatSeoResult.seo,
              isFormatting: false,
              formatFailed: formatSeoResult.formatFailed,
              seoFailed: formatSeoResult.seoFailed,
              coverImageUrl: imageResult.coverImageUrl,
              isGeneratingImage: false,
              imageFailed: imageResult.imageFailed,
            }
          : b,
      ),
    );
  };

  const handleFormatBlog = async (index: number) => {
    await formatOne(index, blogs, (updater) => onBlogsChange(updater(blogs)));
  };

  const runFormatBatch = async (targets: number[]) => {
    if (targets.length === 0) return;

    setIsFormattingAll(true);
    setFormatAllProgress({ done: 0, total: targets.length });

    // A shared mutable ref stands in for state here: several formatOne() calls
    // are in flight together, each patching one blog, and onBlogsChange (parent
    // state) can't be read back synchronously between them.
    let latest = blogs;
    const commit = (updater: (prev: ManagedBlog[]) => ManagedBlog[]) => {
      latest = updater(latest);
      onBlogsChange(latest);
    };

    let done = 0;
    await runWithConcurrency(targets, FORMAT_CONCURRENCY, async (index) => {
      await formatOne(index, latest, commit);
      done += 1;
      setFormatAllProgress({ done, total: targets.length });
    });

    setIsFormattingAll(false);
    setFormatAllProgress(null);
  };

  const handleFormatAll = async () => {
    const targets = blogs
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => needsFormatting(b) || needsSeo(b) || needsImage(b))
      .map(({ i }) => i);
    await runFormatBatch(targets);
  };

  const handleRetryFailed = async () => {
    const targets = blogs
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.formatFailed || b.seoFailed || b.imageFailed)
      .map(({ i }) => i);
    await runFormatBatch(targets);
  };

  const pendingCount = blogs.filter((b) => needsFormatting(b) || needsSeo(b)).length;
  const failedCount = blogs.filter((b) => b.formatFailed || b.seoFailed || b.imageFailed).length;
  const readyCount = blogs.length - pendingCount;
  const reviewCount = blogs.filter(needsReview).length;

  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-blue-50 border border-blue-200 p-4 space-y-3">
        <div>
          <p className="text-sm font-semibold text-blue-900 mb-1">
            📚 {blogs.length} Blog{blogs.length !== 1 ? "s" : ""} Extracted
            {pendingCount > 0 && (
              <span className="ml-2 font-normal text-blue-700">
                ({readyCount} of {blogs.length} ready)
              </span>
            )}
          </p>
          <p className="text-xs text-blue-700">
            {pendingCount === 0
              ? "Every blog is formatted with SEO metadata. Review below, then save or publish them all."
              : `Click "Format All with AI" to structure, generate SEO metadata, and render a cover image for all ${blogs.length} at once — ${FORMAT_CONCURRENCY} at a time, so nothing silently drops.`}
          </p>
        </div>

        {!isFormattingAll && failedCount > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <span className="text-xs font-medium text-amber-800">
              {failedCount} blog{failedCount !== 1 ? "s" : ""} had formatting, SEO, or the cover image fail.
            </span>
            <button
              onClick={handleRetryFailed}
              disabled={isCreating}
              className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-700 transition disabled:opacity-50"
            >
              Retry {failedCount}
            </button>
          </div>
        )}

        {pendingCount > 0 && (
          <button
            onClick={handleFormatAll}
            disabled={isFormattingAll || isCreating}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {isFormattingAll ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Formatting {formatAllProgress?.done ?? 0} of {formatAllProgress?.total ?? pendingCount}…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                Format All with AI ({pendingCount})
              </>
            )}
          </button>
        )}
      </div>

      <div className="space-y-2">
        {blogs.map((blog, index) => (
          <div key={index} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            {/* Header */}
            <button
              onClick={() => toggleExpand(index)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50 transition text-left"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-sm font-semibold text-slate-700">
                  {index + 1}
                </div>
                {(blog.coverImageUrl || blog.isGeneratingImage) && (
                  <div className="flex-shrink-0 w-8 h-8 rounded-lg overflow-hidden border border-slate-200 bg-slate-100 flex items-center justify-center">
                    {blog.coverImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={blog.coverImageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Loader2 size={13} className="animate-spin text-slate-400" />
                    )}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-slate-900 truncate text-sm">
                    {blog.title || `Blog ${index + 1}`}
                  </h3>
                  <p className="text-xs text-slate-500 flex flex-wrap items-center gap-x-2">
                    <span>{(blog.charCount ?? blog.text.length).toLocaleString()} characters</span>
                    {blog.validationStatus === "warning" ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700">
                        Warning
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-700">
                        Ready
                      </span>
                    )}
                    {blog.isDuplicate && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">
                        Possible duplicate
                      </span>
                    )}
                    {blog.isFormatting ? (
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <Loader2 size={11} className="animate-spin" /> Formatting…
                      </span>
                    ) : !needsFormatting(blog) && !needsSeo(blog) ? (
                      <span className="inline-flex items-center gap-1">
                        ✓ <span className="text-green-600">Formatted</span>
                      </span>
                    ) : null}
                    {blog.isGeneratingImage ? (
                      <span className="inline-flex items-center gap-1 text-slate-500">
                        <Loader2 size={11} className="animate-spin" /> Generating image…
                      </span>
                    ) : blog.imageFailed ? (
                      <span className="text-amber-600">Image failed</span>
                    ) : null}
                  </p>
                </div>
              </div>
              <div className="flex-shrink-0 ml-2">
                {expandedIndex === index ? (
                  <ChevronUp size={18} className="text-slate-400" />
                ) : (
                  <ChevronDown size={18} className="text-slate-400" />
                )}
              </div>
            </button>

            {/* Expanded Content */}
            {expandedIndex === index && (
              <div className="border-t border-slate-200 px-4 py-3 space-y-3 bg-slate-50">
                {blog.isDuplicate && (
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-800">
                    This title or slug matches an existing post — or another article in this upload.
                    It will still be saved as a draft for you to check, but will not be auto-published.
                  </div>
                )}
                {blog.validationStatus === "warning" && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-800">
                    This article is longer than the 60,000-character guideline. Nothing was cut — it
                    will be saved as a draft for manual review instead of being auto-published.
                  </div>
                )}
                {/* Preview */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-2">
                    Content Preview
                  </label>
                  <div className="bg-white rounded-lg border border-slate-200 p-3 max-h-48 overflow-y-auto">
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {blog.text.slice(0, 300)}
                      {blog.text.length > 300 && "..."}
                    </p>
                  </div>
                </div>

                {/* Cover Image */}
                {(blog.coverImageUrl || blog.isGeneratingImage || blog.imageFailed) && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-2">
                      Cover Image
                    </label>
                    {blog.coverImageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={blog.coverImageUrl}
                        alt=""
                        className="w-full max-h-48 object-cover rounded-lg border border-slate-200"
                      />
                    ) : blog.isGeneratingImage ? (
                      <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-500">
                        <Loader2 size={13} className="animate-spin" /> Generating a cover image…
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
                        <AlertTriangle size={13} /> Could not generate a cover image. Retry, or add one
                        manually after saving.
                      </div>
                    )}
                  </div>
                )}

                {/* Formatted HTML Preview (if formatted) */}
                {blog.html.trim().length > 0 && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-2">
                      Formatted HTML
                    </label>
                    <div
                      className="bg-white rounded-lg border border-green-200 p-3 max-h-48 overflow-y-auto text-xs"
                      dangerouslySetInnerHTML={{ __html: blog.html.slice(0, 500) }}
                    />
                  </div>
                )}

                {/* SEO Preview */}
                {blog.seo && (
                  <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-green-900 mb-2">SEO Metadata Generated</p>
                    <div className="space-y-1 text-xs">
                      <p>
                        <strong>Title:</strong> {(blog.seo as Record<string, unknown>).metaTitle as string}
                      </p>
                      <p>
                        <strong>Description:</strong>{" "}
                        {(blog.seo as Record<string, unknown>).metaDescription as string}
                      </p>
                      <p>
                        <strong>Keyword:</strong>{" "}
                        {(blog.seo as Record<string, unknown>).focusKeyword as string}
                      </p>
                    </div>
                  </div>
                )}

                {/* Warnings */}
                {blog.warnings.length > 0 && (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-amber-900 mb-2 flex items-center gap-1">
                      <AlertTriangle size={14} /> Check before publishing
                    </p>
                    <ul className="space-y-1">
                      {blog.warnings.map((w, i) => (
                        <li key={i} className="text-xs text-amber-800">
                          • {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Format Button — a retry for this one blog; "Format All" above covers the normal path */}
                {(needsFormatting(blog) || needsSeo(blog)) && (
                  <button
                    onClick={() => handleFormatBlog(index)}
                    disabled={blog.isFormatting || isCreating || isFormattingAll}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                  >
                    {blog.isFormatting ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        Formatting…
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        Format with AI
                      </>
                    )}
                  </button>
                )}

                {!needsFormatting(blog) && !needsSeo(blog) && (
                  <div className="flex items-center gap-2 rounded-lg bg-green-50 px-4 py-2 text-sm font-medium text-green-700">
                    <CheckCircle2 size={16} />
                    Formatted and ready
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Save / Publish */}
      {pendingCount > 0 && (
        <p className="text-center text-xs text-amber-700">
          {pendingCount} blog{pendingCount !== 1 ? "s" : ""} still need formatting or SEO — publishing is
          disabled until every blog is ready. You can still save what&apos;s ready as drafts.
        </p>
      )}
      {reviewCount > 0 && (
        <p className="text-center text-xs text-amber-700">
          {reviewCount} blog{reviewCount !== 1 ? "s" : ""} flagged (oversized or a possible duplicate) —
          {reviewCount !== 1 ? " they" : " it"} will be saved as a draft for review instead of published.
        </p>
      )}
      <div className="flex flex-col sm:flex-row gap-2">
        <button
          onClick={() => onCreateAll(false)}
          disabled={isCreating || isFormattingAll || blogs.some((b) => b.isFormatting)}
          className="flex-1 rounded-xl bg-slate-100 text-slate-700 px-5 py-3 text-sm font-medium transition hover:bg-slate-200 disabled:opacity-50"
        >
          {isCreating && creatingMode === "draft" ? (
            <>
              <Loader2 size={16} className="mr-2 inline-block animate-spin" />
              Saving {blogs.length} draft{blogs.length !== 1 ? "s" : ""}…
            </>
          ) : (
            `Save All ${blogs.length} as Draft${blogs.length !== 1 ? "s" : ""}`
          )}
        </button>
        <button
          onClick={() => onCreateAll(true)}
          disabled={
            isCreating ||
            isFormattingAll ||
            pendingCount > 0 ||
            reviewCount === blogs.length ||
            blogs.some((b) => b.isFormatting)
          }
          title={
            pendingCount > 0
              ? "Format every blog first — publishing needs its SEO metadata."
              : reviewCount === blogs.length
                ? "Every blog is flagged for review — save as drafts instead."
                : undefined
          }
          className="flex-1 rounded-xl bg-brand-primary px-5 py-3 text-sm font-medium text-white transition hover:bg-brand-primaryHover disabled:opacity-50"
        >
          {isCreating && creatingMode === "publish" ? (
            <>
              <Loader2 size={16} className="mr-2 inline-block animate-spin" />
              Publishing {blogs.length - reviewCount} Blog{blogs.length - reviewCount !== 1 ? "s" : ""}…
            </>
          ) : reviewCount > 0 ? (
            `✓ Publish ${blogs.length - reviewCount} Ready (${reviewCount} kept as draft)`
          ) : (
            `✓ Publish All ${blogs.length} Blog${blogs.length !== 1 ? "s" : ""}`
          )}
        </button>
      </div>
    </div>
  );
}
