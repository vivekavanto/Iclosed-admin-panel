"use client";

import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import { BLOB_ACCESS } from "@/lib/blobPrivacy";
import {
  Plus,
  Search,
  Loader2,
  Trash2,
  Newspaper,
  AlertTriangle,
  Upload,
  CheckCircle2,
  X,
} from "lucide-react";
import BlogBatchManager, { needsReview, type ManagedBlog } from "./BlogBatchManager";

/**
 * The Blogs list — every post in `blog_posts`, whatever its status.
 *
 * The table is shared with the customer portal (iclosed_dev_web), which renders
 * the published rows on /blogs and on the client dashboard. This app is the
 * only place they are written, so a row that never leaves "draft" here is a row
 * no client will ever see.
 */

type PostRow = {
  id: string;
  slug: string;
  status: "draft" | "scheduled" | "published";
  title: string;
  excerpt: string | null;
  author: string;
  tags: string[];
  published_at: string | null;
  updated_at: string;
  updated_by_email: string | null;
  format_source: string;
  seo_source: string;
};

const STATUS_FILTERS = ["all", "published", "draft"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

const Blogs: React.FC = () => {
  const [posts, setPosts] = useState<PostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  // Import popup: extract → review/format → create. Kept as one dialog rather
  // than a silent upload, because a document can hold up to 10 articles and the
  // admin needs to see (and steer) formatting before anything is saved.
  //
  // "error" is distinct from "idle": the modal is only rendered while
  // importStage !== "idle", so an extraction failure that reset straight to
  // "idle" would close the dialog in the same instant it set the error
  // message — the popup would flash open and vanish with nothing shown. Going
  // to "error" instead keeps it open so the admin actually sees why.
  const [importStage, setImportStage] = useState<
    "idle" | "extracting" | "review" | "creating" | "error"
  >("idle");
  const [importFileName, setImportFileName] = useState("");
  const [importBlogs, setImportBlogs] = useState<ManagedBlog[]>([]);
  const [importError, setImportError] = useState<string | null>(null);
  const [importCreateMode, setImportCreateMode] = useState<"draft" | "publish" | null>(null);
  const [importBatchId, setImportBatchId] = useState<string | null>(null);

  const loadPosts = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/blog");
      const data = await res.json();
      if (data?.success) {
        setPosts(data.posts ?? []);
        setError(null);
      } else {
        setError(data?.error ?? "Failed to load posts.");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred rather than awaited inline so mounting the list doesn't set
    // state synchronously inside the effect body — same shape the sidebar's
    // new-lead poll uses.
    const t = setTimeout(() => {
      void loadPosts();
    }, 0);
    return () => clearTimeout(t);
  }, [loadPosts]);

  const handleDelete = async (post: PostRow) => {
    const live = post.status === "published";
    const warning = live
      ? `"${post.title}" is LIVE. Deleting it removes /blogs/${post.slug} for readers and for search engines. Continue?`
      : `Delete the draft "${post.title}"?`;
    if (!confirm(warning)) return;

    setDeletingId(post.id);
    try {
      const res = await fetch(`/api/admin/blog/${post.id}`, { method: "DELETE" });
      const data = await res.json();
      if (data?.success) {
        setPosts((prev) => prev.filter((p) => p.id !== post.id));
      } else {
        alert(`Could not delete: ${data?.error ?? "Unknown error"}`);
      }
    } catch {
      alert("Could not reach the server.");
    } finally {
      setDeletingId(null);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const targets = posts.filter((p) => selectedIds.has(p.id));
    const liveCount = targets.filter((p) => p.status === "published").length;
    const warning =
      liveCount > 0
        ? `Delete ${ids.length} post${ids.length !== 1 ? "s" : ""}? ${liveCount} of them are LIVE and will disappear from the client site immediately.`
        : `Delete ${ids.length} post${ids.length !== 1 ? "s" : ""}?`;
    if (!confirm(warning)) return;

    setBulkDeleting(true);
    try {
      const results = await Promise.all(
        ids.map(async (id) => {
          try {
            const res = await fetch(`/api/admin/blog/${id}`, { method: "DELETE" });
            const data = await res.json();
            return { id, ok: Boolean(data?.success), error: data?.error as string | undefined };
          } catch {
            return { id, ok: false, error: "Could not reach the server." };
          }
        }),
      );

      const deletedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const failures = results.filter((r) => !r.ok);

      setPosts((prev) => prev.filter((p) => !deletedIds.has(p.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        deletedIds.forEach((id) => next.delete(id));
        return next;
      });

      if (failures.length > 0) {
        alert(
          `Deleted ${deletedIds.size} of ${ids.length}. ${failures.length} failed: ${failures[0].error ?? "Unknown error"}`,
        );
      }
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleImportFile = async (file: File) => {
    setImportError(null);
    setImportFileName(file.name);
    setImportStage("extracting");

    try {
      // Straight to Vercel Blob from the browser, not through this function —
      // a serverless function's request body is capped around 4.5 MB, well
      // under the 20 MB a multi-article document can legitimately need. The
      // import route reads the bytes back from the blobUrl and deletes it
      // once done; this upload is scratch, not a kept document.
      const blob = await upload(`blog-imports/${Date.now()}-${file.name}`, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/admin/blog/import/token",
      });

      const res = await fetch("/api/admin/blog/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blobUrl: blob.url,
          fileName: file.name,
          multiple: true,
          extractOnly: true,
        }),
      });
      const data = await res.json();

      if (!res.ok || !data.success) {
        setImportError(data.error ?? "Could not read blogs from that document.");
        setImportStage("error");
        return;
      }

      const blogs: ManagedBlog[] = (data.articles ?? []).map((a: Record<string, unknown>) => ({
        title: (a.title as string) || "",
        text: (a.text as string) || "",
        html: (a.html as string) || "",
        formatSource: (a.formatSource as ManagedBlog["formatSource"]) || "manual",
        formatModel: (a.formatModel as string | undefined) ?? undefined,
        wordsPreserved: (a.wordsPreserved as number | undefined) ?? undefined,
        needsProofread: Boolean(a.needsProofread),
        seo: (a.seo as Record<string, unknown> | null) ?? undefined,
        warnings: (a.warnings as string[]) ?? [],
        charCount: (a.charCount as number | undefined) ?? (a.text as string)?.length,
        isDuplicate: Boolean(a.isDuplicate),
        validationStatus: (a.validationStatus as ManagedBlog["validationStatus"]) ?? "ready",
      }));

      if (blogs.length === 0) {
        setImportError("No article text could be found in that document.");
        setImportStage("error");
        return;
      }

      setImportBlogs(blogs);
      setImportBatchId(crypto.randomUUID());
      setImportStage("review");
    } catch (err) {
      setImportError(
        err instanceof Error && err.message ? err.message : "Could not upload or read that document.",
      );
      setImportStage("error");
    } finally {
      if (uploadInput.current) uploadInput.current.value = "";
    }
  };

  const closeImportModal = () => {
    setImportStage("idle");
    setImportBlogs([]);
    setImportError(null);
    setImportFileName("");
    setImportCreateMode(null);
    setImportBatchId(null);
  };

  /**
   * Creates every reviewed blog as a draft, then — when `publish` is true —
   * publishes each one it just created.
   *
   * The create call always writes status "draft" (POST /api/admin/blog
   * enforces that, see route.ts), so "publish" here is really two steps: save,
   * then flip each new row live through the same pre-flight checks a single
   * post's Publish button goes through (content + excerpt present). A blog
   * whose SEO drafting failed still gets an excerpt — pulled from its own
   * text — so a real Gemini outage never silently blocks publishing on a
   * missing field the admin never sees.
   */
  const handleCreateAllImported = async (publish: boolean) => {
    setImportStage("creating");
    setImportCreateMode(publish ? "publish" : "draft");
    setImportError(null);

    try {
      const created = await Promise.all(
        importBlogs.map(async (blog) => {
          const seo = (blog.seo as Record<string, unknown> | undefined) ?? {};
          const fallbackExcerpt = blog.text.replace(/\s+/g, " ").trim().slice(0, 200);
          const res = await fetch("/api/admin/blog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: blog.title?.trim() || "Untitled",
              content_html: blog.html,
              content_source: blog.text,
              excerpt: (seo.excerpt as string)?.trim() || fallbackExcerpt,
              cover_image_url: blog.coverImageUrl || null,
              cover_image_alt: blog.coverImageAlt || null,
              author: "iClosed Real Estate Law Desk",
              tags: (seo.tags as string[]) ?? [],
              meta_title: (seo.metaTitle as string) ?? null,
              meta_description: (seo.metaDescription as string) ?? null,
              focus_keyword: (seo.focusKeyword as string) ?? null,
              faq: (seo.faq as unknown[]) ?? [],
              noindex: false,
              format_source: blog.formatSource,
              seo_source: blog.seo ? "gemini" : "manual",
              import_batch_id: importBatchId,
            }),
          });
          const data = await res.json();
          if (!data?.success) {
            return { title: blog.title, ok: false as const, error: data?.error as string | undefined };
          }
          return {
            title: blog.title,
            ok: true as const,
            id: data.post.id as string,
            needsReview: needsReview(blog),
          };
        }),
      );

      const createFailures = created.filter((r) => !r.ok);
      const createdOk = created.filter((r) => r.ok) as Extract<
        (typeof created)[number],
        { ok: true }
      >[];
      // Oversized or duplicate-flagged articles are saved above like everything
      // else, but never auto-published — they stay drafts until a human clears
      // the flag, per the "never truncate, never silently publish" rule.
      const publishable = createdOk.filter((c) => !c.needsReview);
      const keptForReview = createdOk.length - publishable.length;

      let publishFailures: { title: string; error?: string }[] = [];
      if (publish && publishable.length > 0) {
        const publishResults = await Promise.all(
          publishable.map(async (c) => {
            const res = await fetch(`/api/admin/blog/${c.id}/publish`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ publish: true }),
            });
            const data = await res.json();
            return data?.success ? null : { title: c.title, error: data?.error as string | undefined };
          }),
        );
        publishFailures = publishResults.filter(
          (r): r is { title: string; error: string | undefined } => r !== null,
        );
      }

      await loadPosts();

      if (createFailures.length > 0 || publishFailures.length > 0) {
        const parts: string[] = [];
        if (createFailures.length > 0) {
          parts.push(`${createFailures.length} could not be saved (${createFailures[0].error ?? "unknown error"})`);
        }
        if (publishFailures.length > 0) {
          parts.push(
            `${publishFailures.length} saved as drafts but could not publish (${publishFailures[0].error ?? "unknown error"})`,
          );
        }
        setImportError(
          `${created.length - createFailures.length - publishFailures.length} of ${created.length} blogs published successfully. ${parts.join("; ")}.`,
        );
        setImportStage("review");
        setImportCreateMode(null);
        return;
      }

      closeImportModal();
      setImportCreateMode(null);
      setUploadSuccess(
        publish
          ? `✓ Published ${publishable.length} blog${publishable.length !== 1 ? "s" : ""}` +
              (keptForReview > 0 ? ` · ${keptForReview} kept as draft for review` : "")
          : `✓ Saved ${created.length} blog draft${created.length !== 1 ? "s" : ""}`,
      );
      setTimeout(() => setUploadSuccess(null), 3000);
    } catch {
      setImportError("Could not reach the server while saving the posts.");
      setImportStage("review");
      setImportCreateMode(null);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return posts.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!q) return true;
      const haystack = [p.title, p.slug, p.excerpt, p.author, ...(p.tags ?? [])]
        .filter(Boolean)
        .join(" | ")
        .toLowerCase();
      return q.split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
    });
  }, [posts, search, statusFilter]);

  const publishedCount = posts.filter((p) => p.status === "published").length;
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selectedIds.has(p.id));
  const someFilteredSelected = filtered.some((p) => selectedIds.has(p.id));
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someFilteredSelected && !allFilteredSelected;
    }
  }, [someFilteredSelected, allFilteredSelected]);

  const toggleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((p) => next.delete(p.id));
      } else {
        filtered.forEach((p) => next.add(p.id));
      }
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500 py-4">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Blogs</h1>
          <p className="text-sm text-slate-500 mt-1">
            Write and publish the articles on the client website.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by title, slug or tag"
              className="pl-9 pr-3 py-2.5 w-72 max-w-full rounded-xl border border-slate-200 text-sm outline-none focus:border-brand-primary"
            />
          </div>

          <input
            ref={uploadInput}
            type="file"
            accept=".docx,.pdf,.txt,.md,.markdown,.html,.htm"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                void handleImportFile(file);
              }
            }}
          />

          <button
            onClick={() => uploadInput.current?.click()}
            disabled={importStage === "extracting"}
            className="inline-flex items-center gap-2 bg-slate-100 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50"
            title="Upload document (PDF, Word, Markdown, etc.) with one or more blog articles"
          >
            {importStage === "extracting" ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Reading…
              </>
            ) : (
              <>
                <Upload size={15} />
                Import blogs
              </>
            )}
          </button>

          <Link
            href="/admin/blogs/new"
            className="inline-flex items-center gap-2 bg-brand-primary text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-brand-primaryHover transition-colors"
          >
            <Plus size={15} />
            New post
          </Link>
        </div>
      </div>

      {/* Status filter + counts */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_FILTERS.map((key) => (
          <button
            key={key}
            onClick={() => setStatusFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-bold capitalize border transition-colors ${
              statusFilter === key
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-600 border-slate-200 hover:border-slate-300"
            }`}
          >
            {key}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-400 font-medium">
          {publishedCount} live · {posts.length - publishedCount} unpublished
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {uploadSuccess && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-green-200 bg-green-50 text-sm text-green-700">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{uploadSuccess}</span>
        </div>
      )}

      {/* Bulk selection bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-brand-primary/20 bg-brand-light/30">
          <span className="text-sm font-medium text-slate-700">
            {selectedIds.size} post{selectedIds.size !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              disabled={bulkDeleting}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-white transition-colors disabled:opacity-50"
            >
              Clear
            </button>
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {bulkDeleting ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 size={13} />
                  Delete selected
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* List */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin" />
            Loading posts…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Newspaper size={32} className="mb-3 text-slate-200" />
            <p className="font-semibold">
              {posts.length === 0 ? "No posts yet" : "No posts match this filter"}
            </p>
            <p className="text-sm mt-1">
              {posts.length === 0
                ? "Create one, paste the article text, and let AI handle the formatting."
                : "Try a different search or status."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            <div className="flex items-center gap-3 px-5 py-2.5 bg-slate-50/80">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allFilteredSelected}
                onChange={toggleSelectAllFiltered}
                className="shrink-0 h-4 w-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary"
                title="Select all"
              />
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Select all
              </span>
            </div>
            {filtered.map((post) => (
              <div
                key={post.id}
                className="flex flex-wrap items-center gap-3 px-5 py-4 hover:bg-brand-light/20 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(post.id)}
                  onChange={() => toggleSelected(post.id)}
                  className="shrink-0 h-4 w-4 rounded border-slate-300 text-brand-primary focus:ring-brand-primary"
                />

                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                    post.status === "published"
                      ? "bg-green-100 text-green-700 border-green-200"
                      : "bg-slate-100 text-slate-500 border-slate-200"
                  }`}
                >
                  {post.status}
                </span>

                <Link href={`/admin/blogs/${post.id}`} className="min-w-0 flex-1 group">
                  <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-brand-primary transition-colors">
                    {post.title || "(untitled)"}
                  </p>
                  <p className="truncate text-xs text-slate-400 mt-0.5">
                    /blogs/{post.slug}
                    {post.status === "published" && post.published_at
                      ? ` · published ${formatDate(post.published_at)}`
                      : ""}
                  </p>
                </Link>

                <span className="shrink-0 text-xs text-slate-400 w-28 text-right">
                  {formatDate(post.updated_at)}
                </span>

                <button
                  onClick={() => handleDelete(post)}
                  disabled={deletingId === post.id}
                  title="Delete post"
                  className="shrink-0 p-1 text-slate-300 hover:text-red-500 transition-colors disabled:opacity-50"
                >
                  {deletingId === post.id ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="pt-2 text-center text-[10px] text-slate-300 font-bold uppercase tracking-widest">
        {filtered.length} of {posts.length} posts
      </p>

      {/* Import popup: extract → format → create */}
      {importStage !== "idle" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white">
              <div>
                <h2 className="text-base font-bold text-slate-900">Import blogs</h2>
                {importFileName && (
                  <p className="text-xs text-slate-400 mt-0.5 truncate max-w-md">{importFileName}</p>
                )}
              </div>
              {importStage !== "extracting" && importStage !== "creating" && (
                <button
                  onClick={closeImportModal}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                  title="Close"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <div className="p-5">
              {importStage === "extracting" && (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-slate-500">
                  <Loader2 size={28} className="animate-spin text-brand-primary" />
                  <p className="text-sm font-medium">Reading blogs from the document…</p>
                  <p className="text-xs text-slate-400">This only reads the text — nothing is saved yet.</p>
                </div>
              )}

              {importError && importStage !== "extracting" && (
                <div className="flex items-start gap-2 px-4 py-3 mb-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}

              {(importStage === "review" || importStage === "creating") && (
                <BlogBatchManager
                  blogs={importBlogs}
                  onBlogsChange={setImportBlogs}
                  onCreateAll={handleCreateAllImported}
                  isCreating={importStage === "creating"}
                  creatingMode={importCreateMode}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Blogs;
