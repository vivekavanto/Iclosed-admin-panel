"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Plus,
  Search,
  Sparkles,
  Loader2,
  Trash2,
  Newspaper,
  AlertTriangle,
} from "lucide-react";

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
            {filtered.map((post) => (
              <div
                key={post.id}
                className="flex flex-wrap items-center gap-3 px-5 py-4 hover:bg-brand-light/20 transition-colors"
              >
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

                {/* An unedited machine draft is the one thing worth surfacing
                    in a list view: it is the post most likely to need a
                    lawyer's eye before it goes near a reader. */}
                {(post.format_source === "gemini" || post.seo_source === "gemini") && (
                  <span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-[10px] font-bold uppercase tracking-wider text-amber-700">
                    <Sparkles size={10} />
                    Unreviewed AI
                  </span>
                )}

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
    </div>
  );
};

export default Blogs;
