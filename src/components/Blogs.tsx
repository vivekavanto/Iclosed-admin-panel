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
  Send,
} from "lucide-react";
import BlogImportProgress from "./BlogImportProgress";
import { slugify } from "@/lib/blogSlug";

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
  created_at: string;
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
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);

  // Import: the browser only uploads the document and queues it. Splitting,
  // formatting, SEO and cover images run on the server
  // (src/lib/blogImportQueue.ts) straight into draft posts, and
  // BlogImportProgress shows how far along it is — so the admin is never held
  // on this page, and closing the tab loses nothing.
  //
  // The dialog opens once a file is picked, to ask whether ready articles
  // should go live automatically; it closes as soon as the upload is queued.
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const [publishWhenReady, setPublishWhenReady] = useState(false);
  // Backdate the document's blogs, N per date; blank = off.
  const [blogsPerDate, setBlogsPerDate] = useState("");
  const [importUploading, setImportUploading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importRefreshKey, setImportRefreshKey] = useState(0);

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

  /**
   * Publishes every selected draft through the same route as a post's own
   * Publish button, so each one still passes its pre-flight checks (content +
   * excerpt). Already-live posts in the selection are skipped. Five at a time
   * rather than all at once: each publish also pings the portal to drop its
   * cache, and a large selection shouldn't hit it with a burst.
   */
  const handleBulkPublish = async () => {
    const drafts = posts.filter((p) => selectedIds.has(p.id) && p.status !== "published");
    if (drafts.length === 0) return;
    if (
      !confirm(
        `Publish ${drafts.length} draft${drafts.length !== 1 ? "s" : ""}? They will go live on the client site immediately.`,
      )
    ) {
      return;
    }

    setBulkPublishing(true);
    try {
      const results: { id: string; title: string; ok: boolean; error?: string; post?: PostRow }[] = [];
      for (let i = 0; i < drafts.length; i += 5) {
        const chunk = drafts.slice(i, i + 5);
        results.push(
          ...(await Promise.all(
            chunk.map(async (p) => {
              try {
                const res = await fetch(`/api/admin/blog/${p.id}/publish`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ publish: true }),
                });
                const data = await res.json();
                return {
                  id: p.id,
                  title: p.title,
                  ok: Boolean(data?.success),
                  error: data?.error as string | undefined,
                  post: data?.post as PostRow | undefined,
                };
              } catch {
                return { id: p.id, title: p.title, ok: false, error: "Could not reach the server." };
              }
            }),
          )),
        );
      }

      const published = new Map(results.filter((r) => r.ok && r.post).map((r) => [r.id, r.post!]));
      const failures = results.filter((r) => !r.ok);

      setPosts((prev) => prev.map((p) => (published.has(p.id) ? { ...p, ...published.get(p.id)! } : p)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        published.forEach((_, id) => next.delete(id));
        return next;
      });

      if (published.size > 0) {
        setUploadSuccess(`✓ Published ${published.size} blog${published.size !== 1 ? "s" : ""}`);
        setTimeout(() => setUploadSuccess(null), 3000);
      }
      if (failures.length > 0) {
        alert(
          `Published ${published.size} of ${drafts.length}. ${failures.length} could not be published — they are still selected:\n\n` +
            failures.map((f) => `• ${f.title}: ${f.error ?? "Unknown error"}`).join("\n"),
        );
      }
    } finally {
      setBulkPublishing(false);
    }
  };

  const closeImportModal = () => {
    setPendingImport(null);
    setImportError(null);
    setPublishWhenReady(false);
    setBlogsPerDate("");
    if (uploadInput.current) uploadInput.current.value = "";
  };

  const handleStartImport = async () => {
    const file = pendingImport;
    if (!file) return;
    setImportError(null);
    setImportUploading(true);

    try {
      // Straight to Vercel Blob from the browser, not through a function — a
      // serverless request body is capped around 4.5 MB, well under the 20 MB
      // a multi-article document can need. The queue worker reads it back and
      // deletes it once the articles are out; it is scratch, not a kept file.
      const blob = await upload(`blog-imports/${Date.now()}-${file.name}`, file, {
        access: BLOB_ACCESS,
        handleUploadUrl: "/api/admin/blog/import/token",
      });

      const res = await fetch("/api/admin/blog/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blobUrl: blob.url, fileName: file.name, publishWhenReady, blogsPerDate: blogsPerDate.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setImportError(data.error ?? "Could not queue that document.");
        return;
      }

      closeImportModal();
      setImportRefreshKey((k) => k + 1);
      setUploadSuccess(
        `✓ "${file.name}" is processing in the background — you can keep working or leave this page.`,
      );
      setTimeout(() => setUploadSuccess(null), 5000);
    } catch (err) {
      setImportError(
        err instanceof Error && err.message ? err.message : "Could not upload that document.",
      );
    } finally {
      setImportUploading(false);
    }
  };

  /**
   * Posts that repeat an OLDER post's title (compared as slugs, so case and
   * punctuation don't matter), mapped to the title of the one they copy. The
   * oldest post in a group is the original and is never flagged, so deleting
   * the copies — or the original — clears the badge on its own. Imports save
   * duplicates as drafts rather than dropping them; this is how the admin
   * spots them.
   */
  const duplicateOf = useMemo(() => {
    const byKey = new Map<string, PostRow[]>();
    for (const p of posts) {
      const key = slugify(p.title || "");
      if (!key) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), p]);
    }
    const out = new Map<string, string>();
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      const [original, ...copies] = [...group].sort((a, b) => a.created_at.localeCompare(b.created_at));
      for (const c of copies) out.set(c.id, original.title);
    }
    return out;
  }, [posts]);

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
  const selectedDraftCount = posts.filter((p) => selectedIds.has(p.id) && p.status !== "published").length;
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
                setImportError(null);
                setPendingImport(file);
              }
            }}
          />

          <button
            onClick={() => uploadInput.current?.click()}
            className="inline-flex items-center gap-2 bg-slate-100 text-slate-700 px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50"
            title="Upload document (PDF, Word, Markdown, etc.) with one or more blog articles"
          >
            <Upload size={15} />
            Import blogs
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

      <BlogImportProgress refreshKey={importRefreshKey} onPostsChanged={loadPosts} />

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
              disabled={bulkDeleting || bulkPublishing}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-white transition-colors disabled:opacity-50"
            >
              Clear
            </button>
            {/* Bulk publish lives on the Draft tab only — on All/Published a
                select-all would mostly pick up posts that are already live. */}
            {statusFilter === "draft" && (
              <button
                onClick={handleBulkPublish}
                disabled={bulkDeleting || bulkPublishing || selectedDraftCount === 0}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-brand-primary hover:bg-brand-primaryHover transition-colors disabled:opacity-50"
              >
                {bulkPublishing ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Publishing…
                  </>
                ) : (
                  <>
                    <Send size={13} />
                    Publish selected ({selectedDraftCount})
                  </>
                )}
              </button>
            )}
            <button
              onClick={handleBulkDelete}
              disabled={bulkDeleting || bulkPublishing}
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
                  {/* Badge sits AFTER the title so every title starts at the same x. */}
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-900 group-hover:text-brand-primary transition-colors">
                      {post.title || "(untitled)"}
                    </p>
                    {duplicateOf.has(post.id) && (
                      <span
                        title={`Same title as an older post: "${duplicateOf.get(post.id)}". Delete this one if it isn't needed.`}
                        className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border bg-red-100 text-red-700 border-red-200"
                      >
                        Duplicate
                      </span>
                    )}
                  </div>
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

      {/* Import: pick options, upload, queue — the work itself runs in the background */}
      {pendingImport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-slate-900">Import blogs</h2>
                <p className="text-xs text-slate-400 mt-0.5 truncate">{pendingImport.name}</p>
              </div>
              {!importUploading && (
                <button
                  onClick={closeImportModal}
                  className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                  title="Close"
                >
                  <X size={18} />
                </button>
              )}
            </div>

            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-600">
                Each article is saved as a draft, then formatted and given SEO and a cover image in
                the background. You can keep working.
              </p>

              <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                <p className="font-semibold text-slate-700">How it splits</p>
                <p className="mt-1">
                  One document = <strong>one blog</strong>. Sections and FAQs stay inside it.
                </p>
                <p className="mt-2">For several blogs, put one of these on its own line:</p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {[
                    "END OF BLOG",
                    "START OF BLOG",
                    "---",
                    "Blog 1:",
                    "Continue the series",
                    "Start of the series",
                  ].map((marker) => (
                    <code key={marker} className="rounded bg-white px-1.5 py-0.5 font-mono">
                      {marker}
                    </code>
                  ))}
                </div>
                <p className="mt-2">
                  Or give each blog a <strong>Heading 1</strong> in Word.
                </p>
              </div>

              <label className="flex items-start gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={publishWhenReady}
                  onChange={(e) => setPublishWhenReady(e.target.checked)}
                  disabled={importUploading}
                  className="mt-0.5 rounded border-slate-300 text-brand-primary focus:ring-brand-primary"
                />
                <span>
                  Publish automatically when ready
                  <span className="block text-xs text-slate-400">
                    Oversized articles and possible duplicates always stay drafts for review.
                  </span>
                </span>
              </label>

              <div className="text-sm text-slate-700">
                <label className="flex items-center gap-2.5">
                  <span>Blogs per date</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    step={1}
                    value={blogsPerDate}
                    onChange={(e) => setBlogsPerDate(e.target.value)}
                    disabled={importUploading}
                    placeholder="Off"
                    className="w-20 rounded border border-slate-300 px-2 py-1 text-sm"
                  />
                </label>
                <span className="block text-xs text-slate-400 mt-1">
                  Optional. Dates the blogs this many per date, continuing from the latest blog date on the site and
                  never going past today. If there are more blogs than days, they are shared equally across the days.
                  Leave blank to date each blog when it is published.
                </span>
              </div>

              {importError && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                  <span>{importError}</span>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <button
                  onClick={closeImportModal}
                  disabled={importUploading}
                  className="rounded-xl bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleStartImport()}
                  disabled={importUploading}
                  className="inline-flex items-center gap-2 rounded-xl bg-brand-primary px-4 py-2.5 text-sm font-medium text-white hover:bg-brand-primaryHover disabled:opacity-50"
                >
                  {importUploading ? (
                    <>
                      <Loader2 size={15} className="animate-spin" />
                      Uploading…
                    </>
                  ) : (
                    <>
                      <Upload size={15} />
                      Start import
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Blogs;
