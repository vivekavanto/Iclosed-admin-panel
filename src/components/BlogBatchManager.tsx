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
};

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
    commit((prev) => prev.map((b, i) => (i === index ? { ...b, isFormatting: true } : b)));

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

    commit((prev) =>
      prev.map((b, i) =>
        i === index
          ? {
              ...b,
              html,
              formatSource,
              formatModel,
              wordsPreserved,
              warnings: notes,
              seo,
              isFormatting: false,
              formatFailed,
              seoFailed,
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
      .filter(({ b }) => needsFormatting(b) || needsSeo(b))
      .map(({ i }) => i);
    await runFormatBatch(targets);
  };

  const handleRetryFailed = async () => {
    const targets = blogs
      .map((b, i) => ({ b, i }))
      .filter(({ b }) => b.formatFailed || b.seoFailed)
      .map(({ i }) => i);
    await runFormatBatch(targets);
  };

  const pendingCount = blogs.filter((b) => needsFormatting(b) || needsSeo(b)).length;
  const failedCount = blogs.filter((b) => b.formatFailed || b.seoFailed).length;
  const readyCount = blogs.length - pendingCount;

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
              : `Click "Format All with AI" to structure and generate SEO metadata for all ${blogs.length} at once — ${FORMAT_CONCURRENCY} at a time, so metadata doesn't silently drop.`}
          </p>
        </div>

        {!isFormattingAll && failedCount > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
            <span className="text-xs font-medium text-amber-800">
              {failedCount} blog{failedCount !== 1 ? "s" : ""} could not be formatted or given SEO metadata.
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
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-slate-900 truncate text-sm">
                    {blog.title || `Blog ${index + 1}`}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {Math.round(blog.text.length / 100) * 100} characters
                    {blog.isFormatting ? (
                      <span className="ml-2 inline-flex items-center gap-1 text-slate-500">
                        <Loader2 size={11} className="animate-spin" /> Formatting…
                      </span>
                    ) : !needsFormatting(blog) && !needsSeo(blog) ? (
                      <span className="ml-2 inline-flex items-center gap-1">
                        ✓ <span className="text-green-600">Formatted</span>
                      </span>
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
          disabled={isCreating || isFormattingAll || pendingCount > 0 || blogs.some((b) => b.isFormatting)}
          title={pendingCount > 0 ? "Format every blog first — publishing needs its SEO metadata." : undefined}
          className="flex-1 rounded-xl bg-brand-primary px-5 py-3 text-sm font-medium text-white transition hover:bg-brand-primaryHover disabled:opacity-50"
        >
          {isCreating && creatingMode === "publish" ? (
            <>
              <Loader2 size={16} className="mr-2 inline-block animate-spin" />
              Publishing {blogs.length} Blog{blogs.length !== 1 ? "s" : ""}…
            </>
          ) : (
            `✓ Publish All ${blogs.length} Blog${blogs.length !== 1 ? "s" : ""}`
          )}
        </button>
      </div>
    </div>
  );
}
