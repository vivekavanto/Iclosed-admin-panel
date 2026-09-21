"use client";

import React, { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  Eye,
  Code2,
  Search,
  Plus,
  X,
  ArrowLeft,
  CheckCircle2,
  Upload,
  ImagePlus,
} from "lucide-react";
import BlogArticleBody from "./blog/BlogArticleBody";

/**
 * Create / edit screen for one blog post.
 *
 * Two ways in, both ending in the same place:
 *
 *   Paste   paste the article as plain text, press Format with AI, read what
 *           came back, fix anything, draft the search metadata with AI, fix
 *           that, save, publish.
 *   Upload  drop in the .docx/.pdf/.md/.txt/.html the article was written in
 *           and POST /api/admin/blog/import does the extraction, the
 *           formatting and the metadata in one round trip.
 *
 * Every AI step is deliberately separate from saving, so the admin always sees
 * what the model produced before it becomes the stored copy — the draft is
 * never overwritten by output nobody looked at. That holds for the upload path
 * too: it fills the boxes on screen and nothing else, and Save is still a
 * press away.
 *
 * Publishing writes to the table this app shares with the customer portal. The
 * portal's blog pages revalidate on a five-minute timer, so a post goes live
 * there shortly after Publish, without a deploy on either side.
 */

export type FaqItem = { question: string; answer: string };

export type EditorPost = {
  id: string | null;
  slug: string;
  status: string;
  title: string;
  excerpt: string;
  content_html: string;
  content_source: string;
  cover_image_url: string;
  cover_image_alt: string;
  author: string;
  tags: string[];
  meta_title: string;
  meta_description: string;
  focus_keyword: string;
  faq: FaqItem[];
  noindex: boolean;
  format_source: string;
  seo_source: string;
};

export const EMPTY_POST: EditorPost = {
  id: null,
  slug: "",
  status: "draft",
  title: "",
  excerpt: "",
  content_html: "",
  content_source: "",
  cover_image_url: "",
  cover_image_alt: "",
  author: "iClosed Real Estate Law Desk",
  tags: [],
  meta_title: "",
  meta_description: "",
  focus_keyword: "",
  faq: [],
  noindex: false,
  format_source: "manual",
  seo_source: "manual",
};

/** A row from GET /api/admin/blog/[id], mapped onto the editor's shape. */
export function toEditorPost(row: Record<string, unknown>): EditorPost {
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  return {
    id: str(row.id) || null,
    slug: str(row.slug),
    status: str(row.status, "draft"),
    title: str(row.title),
    // Every nullable column has to arrive as a string: the inputs are all
    // controlled, and a null turns one into an uncontrolled input that React
    // warns about on the first keystroke.
    excerpt: str(row.excerpt),
    content_html: str(row.content_html),
    content_source: str(row.content_source),
    cover_image_url: str(row.cover_image_url),
    cover_image_alt: str(row.cover_image_alt),
    author: str(row.author, EMPTY_POST.author),
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
    meta_title: str(row.meta_title),
    meta_description: str(row.meta_description),
    focus_keyword: str(row.focus_keyword),
    faq: Array.isArray(row.faq) ? (row.faq as FaqItem[]) : [],
    noindex: row.noindex === true,
    format_source: str(row.format_source, "manual"),
    seo_source: str(row.seo_source, "manual"),
  };
}

// Google truncates past roughly these. Shown as a live count so the limit is
// visible while typing rather than discovered in a search result weeks later.
const META_TITLE_MAX = 60;
const META_DESC_MAX = 155;

const inputClass =
  "w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-300 focus:border-brand-primary";

// Kept in step with IMPORT_ACCEPT / IMPORT_LABEL in src/lib/blogImport.ts,
// which is the server-side source of truth. Not imported from there: that
// module pulls in jszip and the Gemini client, and neither belongs in a
// browser bundle just to populate an accept attribute.
const IMPORT_ACCEPT = ".docx,.pdf,.txt,.md,.markdown,.html,.htm";
const COVER_ACCEPT = "image/png,image/jpeg,image/webp,image/avif";

function CharCount({ value, max }: { value: string; max: number }) {
  const over = value.length > max;
  return (
    <span className={`text-[11px] font-medium ${over ? "text-brand-primary" : "text-slate-400"}`}>
      {value.length}/{max}
      {over && " — Google will cut this off"}
    </span>
  );
}

function Field({
  label,
  hint,
  right,
  children,
}: {
  label: string;
  hint?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <label className="text-[12.5px] font-semibold text-slate-700">{label}</label>
        {right}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  );
}

export default function BlogEditor({ initial }: { initial: EditorPost }) {
  const router = useRouter();
  const [post, setPost] = useState<EditorPost>(initial);
  const [formatting, setFormatting] = useState(false);
  const [seoLoading, setSeoLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [coverUploading, setCoverUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHtml, setShowHtml] = useState(false);

  const importInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof EditorPost>(key: K, value: EditorPost[K]) =>
    setPost((p) => ({ ...p, [key]: value }));

  /**
   * Uploads a document and fills the whole draft from it — text, formatted
   * HTML, title and every search field — in one request.
   *
   * Refuses to run over content that is already there. The import replaces the
   * article and the metadata wholesale, and there is no undo in this editor; an
   * admin who has typed half a post and then picks the wrong file would lose it
   * silently. Clearing the box first is one extra action, and it makes the
   * destructive step something they chose rather than something that happened.
   */
  async function handleImport(file: File) {
    setError(null);
    setNotice(null);
    setWarnings([]);

    if (post.content_source.trim() || post.content_html.trim()) {
      setError(
        "This post already has an article in it. Clear the article text and the formatted HTML first, or start a new post — importing replaces both.",
      );
      return;
    }

    setImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      // The typed title wins over the one in the document; the server decides.
      form.append("title", post.title);

      const res = await fetch("/api/admin/blog/import", { method: "POST", body: form });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error ?? "Could not read that file.");
        return;
      }

      const seo = json.seo;
      setPost((p) => ({
        ...p,
        title: json.title || p.title,
        content_source: json.text ?? "",
        content_html: json.html ?? "",
        format_source: json.formatSource ?? "manual",
        ...(seo
          ? {
              meta_title: seo.metaTitle ?? p.meta_title,
              meta_description: seo.metaDescription ?? p.meta_description,
              excerpt: seo.excerpt || p.excerpt,
              focus_keyword: seo.focusKeyword ?? p.focus_keyword,
              tags: seo.tags?.length ? seo.tags : p.tags,
              faq: seo.faq ?? p.faq,
              seo_source: "gemini",
            }
          : {}),
      }));

      setWarnings(json.warnings ?? []);
      setNotice(
        `Imported ${json.fileName}${
          json.wordsPreserved != null
            ? ` — ${Math.round(json.wordsPreserved * 100)}% of the document's wording preserved`
            : ""
        }. Nothing is saved yet: read it through, then press Save draft.`,
      );
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setImporting(false);
      // Reset the picker so choosing the SAME file again still fires onChange.
      if (importInput.current) importInput.current.value = "";
    }
  }

  /** Uploads a cover image to the public blob store and points the post at it. */
  async function handleCoverUpload(file: File) {
    setError(null);
    setNotice(null);

    setCoverUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      // So the route can bin the image this one is taking over from, unless a
      // saved post still points at it.
      form.append("replaces", post.cover_image_url);

      const res = await fetch("/api/admin/blog/cover", { method: "POST", body: form });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error ?? "Could not upload the image.");
        return;
      }

      setPost((p) => ({ ...p, cover_image_url: json.url }));
      setNotice(
        post.cover_image_alt.trim()
          ? "Cover image uploaded."
          : "Cover image uploaded. Add alt text describing it — screen readers and Google both read it.",
      );
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setCoverUploading(false);
      if (coverInput.current) coverInput.current.value = "";
    }
  }

  async function handleFormat() {
    setError(null);
    setNotice(null);
    setWarnings([]);

    const body = post.content_source.trim();
    if (!body) {
      setError("Paste the article text into the draft box first.");
      return;
    }

    setFormatting(true);
    try {
      const res = await fetch("/api/admin/blog/format", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, title: post.title }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error ?? "Formatting failed.");
        return;
      }

      setPost((p) => ({ ...p, content_html: json.html, format_source: "gemini" }));
      setWarnings(json.warnings ?? []);
      setNotice(
        `Formatted with ${json.model} — ${Math.round((json.wordsPreserved ?? 1) * 100)}% of your wording preserved.`,
      );
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setFormatting(false);
    }
  }

  /**
   * Drafts the search metadata. Reads the formatted HTML when there is one and
   * the raw draft otherwise, so this works before or after formatting.
   *
   * It overwrites meta title, meta description, excerpt, focus keyword, tags
   * and FAQ in one go. That is blunt on purpose — a field-by-field merge would
   * leave the admin comparing six half-updated boxes against a warning list,
   * whereas replacing the set means what is on screen is exactly what the model
   * proposed, and nothing is saved until they press Save.
   */
  async function handleGenerateSeo() {
    setError(null);
    setNotice(null);
    setWarnings([]);

    const body = (post.content_html || post.content_source).trim();
    if (!body) {
      setError("Write the article before drafting its search metadata.");
      return;
    }

    setSeoLoading(true);
    try {
      const res = await fetch("/api/admin/blog/seo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, title: post.title }),
      });
      const json = await res.json();

      if (!res.ok || !json.success) {
        setError(json.error ?? "Could not draft the search metadata.");
        return;
      }

      const seo = json.seo;
      setPost((p) => ({
        ...p,
        meta_title: seo.metaTitle ?? p.meta_title,
        meta_description: seo.metaDescription ?? p.meta_description,
        excerpt: seo.excerpt || p.excerpt,
        focus_keyword: seo.focusKeyword ?? p.focus_keyword,
        tags: seo.tags?.length ? seo.tags : p.tags,
        faq: seo.faq ?? p.faq,
        seo_source: "gemini",
      }));
      setWarnings(seo.warnings ?? []);
      setNotice(
        `Search metadata drafted with ${seo.model}. Read it before publishing — these are the words Google and AI answers will quote.`,
      );
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setSeoLoading(false);
    }
  }

  /** Any hand edit to SEO copy means a human has been through it. */
  function reviewedSeo(source: string): string {
    return source === "gemini" ? "gemini_edited" : source;
  }

  function setSeoField<K extends keyof EditorPost>(key: K, value: EditorPost[K]) {
    setPost((p) => ({ ...p, [key]: value, seo_source: reviewedSeo(p.seo_source) }));
  }

  function setFaqItem(index: number, patch: Partial<FaqItem>) {
    setPost((p) => ({
      ...p,
      faq: p.faq.map((item, i) => (i === index ? { ...item, ...patch } : item)),
      seo_source: reviewedSeo(p.seo_source),
    }));
  }

  async function handleSave(): Promise<string | null> {
    setError(null);
    setNotice(null);

    if (!post.title.trim()) {
      setError("A title is required.");
      return null;
    }

    setSaving(true);
    try {
      const payload = {
        title: post.title,
        slug: post.slug || undefined,
        excerpt: post.excerpt,
        content_html: post.content_html,
        content_source: post.content_source,
        cover_image_url: post.cover_image_url || null,
        cover_image_alt: post.cover_image_alt || null,
        author: post.author,
        tags: post.tags,
        meta_title: post.meta_title || null,
        meta_description: post.meta_description || null,
        focus_keyword: post.focus_keyword || null,
        // Blank rows are dropped rather than stored: an empty question would
        // become an empty entry in the FAQPage structured data.
        faq: post.faq.filter((f) => f.question.trim() && f.answer.trim()),
        noindex: post.noindex,
        format_source: post.format_source,
        seo_source: post.seo_source,
      };

      const res = post.id
        ? await fetch(`/api/admin/blog/${post.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/blog", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error ?? "Could not save.");
        return null;
      }

      const saved = json.post;
      setPost((p) => ({ ...p, id: saved.id, slug: saved.slug, status: saved.status }));
      setNotice("Saved.");

      // A new post lives at its own URL from here on, so a second Save does not
      // create a second row.
      if (!post.id) router.replace(`/admin/blogs/${saved.id}`);
      return saved.id as string;
    } catch {
      setError("Could not reach the server.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handlePublish(publish: boolean) {
    // Save first, always. Publishing what is on screen rather than whatever was
    // last written to the table is the only behaviour that is not a trap.
    const id = await handleSave();
    if (!id) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/admin/blog/${id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error ?? "Could not change the status.");
        return;
      }
      setPost((p) => ({ ...p, status: json.post.status, slug: json.post.slug }));
      setNotice(
        publish
          ? "Published. It appears on the client website within about five minutes."
          : "Pulled back to draft.",
      );
    } finally {
      setSaving(false);
    }
  }

  const isPublished = post.status === "published";
  const busy = saving || formatting || seoLoading || importing || coverUploading;

  return (
    <div className="max-w-6xl mx-auto py-4 space-y-5 animate-in fade-in duration-300">
      {/* ── Action bar ───────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => router.push("/admin/blogs")}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
            aria-label="Back to posts"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            {post.id ? "Edit post" : "New post"}
          </h1>
          <span
            className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider border ${
              isPublished
                ? "bg-green-100 text-green-700 border-green-200"
                : "bg-slate-100 text-slate-500 border-slate-200"
            }`}
          >
            {post.status}
          </span>
          {post.format_source === "gemini" && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-700">
              AI formatted — unreviewed
            </span>
          )}
          {post.seo_source === "gemini" && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-amber-700">
              AI SEO — unreviewed
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSave}
            disabled={busy}
            className="rounded-xl border border-slate-200 bg-white px-5 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save draft"}
          </button>
          <button
            onClick={() => handlePublish(!isPublished)}
            disabled={busy}
            className="rounded-xl bg-brand-primary px-5 py-2 text-sm font-medium text-white transition hover:bg-brand-primaryHover disabled:opacity-50"
          >
            {isPublished ? "Unpublish" : "Publish"}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          <span>{notice}</span>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="mb-1 font-semibold">Check these before publishing:</p>
          <ul className="list-disc space-y-1 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ── Left: content ──────────────────────────── */}
        <div className="space-y-5 lg:col-span-2">
          <Field label="Title">
            <input
              value={post.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Why Title Insurance Is Essential for Ontario Homebuyers"
              className={inputClass}
            />
          </Field>

          {/* ── Import ──────────────────────────────────
              The alternative to pasting: one file in, a whole draft out. It
              fills the boxes below and saves nothing, exactly like the two AI
              buttons. */}
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50/60 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[12.5px] font-semibold text-slate-700">
                  Upload the article instead
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">
                  Word (.docx), PDF, Markdown, plain text or HTML, up to 10 MB.
                  Gemini formats it and drafts the meta title, description,
                  excerpt, keyword, tags and FAQ in one go.
                </p>
              </div>

              <input
                ref={importInput}
                type="file"
                accept={IMPORT_ACCEPT}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImport(file);
                }}
              />
              <button
                onClick={() => importInput.current?.click()}
                disabled={busy}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-slate-900 bg-white px-4 py-2 text-[13px] font-medium text-slate-900 transition hover:bg-slate-900 hover:text-white disabled:opacity-50"
              >
                {importing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Reading the document…
                  </>
                ) : (
                  <>
                    <Upload size={14} />
                    Upload document
                  </>
                )}
              </button>
            </div>

            {importing && (
              <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
                A long PDF can take up to a minute — it is read, formatted and
                written up for search in one pass. Leave this tab open.
              </p>
            )}
          </div>

          <Field
            label="Article text"
            hint="Paste the article as plain text, or upload it above. Gemini adds the headings, paragraphs and lists — it does not change your words."
          >
            <textarea
              value={post.content_source}
              onChange={(e) => set("content_source", e.target.value)}
              rows={14}
              placeholder="Paste the full article here…"
              className={`${inputClass} font-mono text-[13px] leading-relaxed`}
            />
          </Field>

          <button
            onClick={handleFormat}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            {formatting ? (
              <>
                <Loader2 size={15} className="animate-spin" />
                Formatting…
              </>
            ) : (
              <>
                <Sparkles size={15} />
                Format with AI
              </>
            )}
          </button>

          {post.content_html && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-slate-900">Formatted article</p>
                <button
                  onClick={() => setShowHtml((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900"
                >
                  {showHtml ? <Eye size={13} /> : <Code2 size={13} />}
                  {showHtml ? "Preview" : "Edit HTML"}
                </button>
              </div>

              {showHtml ? (
                <textarea
                  value={post.content_html}
                  onChange={(e) =>
                    setPost((p) => ({
                      ...p,
                      content_html: e.target.value,
                      // Any hand edit means a human has been through it.
                      format_source:
                        p.format_source === "gemini" ? "gemini_edited" : p.format_source,
                    }))
                  }
                  rows={18}
                  className={`${inputClass} font-mono text-[12.5px] leading-relaxed`}
                />
              ) : (
                <div className="rounded-xl border border-slate-200 bg-white px-6 py-5">
                  <BlogArticleBody html={post.content_html} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Right: metadata ────────────────────────── */}
        <div className="space-y-5">
          <Field
            label="Excerpt"
            hint="Shown on the blog listing and used as the fallback search description. A post cannot be published without one."
          >
            <textarea
              value={post.excerpt}
              onChange={(e) => set("excerpt", e.target.value)}
              rows={3}
              className={inputClass}
            />
          </Field>

          <Field
            label="URL slug"
            hint={post.slug ? `/blogs/${post.slug}` : "Generated from the title."}
          >
            <input
              value={post.slug}
              onChange={(e) => set("slug", e.target.value)}
              placeholder="auto-generated"
              className={inputClass}
            />
            {isPublished && (
              <p className="mt-1 text-[11px] text-amber-700">
                This post is live. Changing the slug breaks existing links to it.
              </p>
            )}
          </Field>

          <Field
            label="Cover image"
            hint="Upload one, or paste a URL. A pasted URL must be PUBLIC — an image in the private blob store renders as a broken image on the client website."
          >
            <input
              value={post.cover_image_url}
              onChange={(e) => set("cover_image_url", e.target.value)}
              placeholder="/blog1.png"
              className={inputClass}
            />

            <input
              ref={coverInput}
              type="file"
              accept={COVER_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleCoverUpload(file);
              }}
            />

            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => coverInput.current?.click()}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 transition hover:border-slate-300 disabled:opacity-50"
              >
                {coverUploading ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Uploading…
                  </>
                ) : (
                  <>
                    <ImagePlus size={13} />
                    {post.cover_image_url ? "Replace image" : "Upload image"}
                  </>
                )}
              </button>

              {post.cover_image_url && (
                <button
                  onClick={() => set("cover_image_url", "")}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] font-medium text-slate-400 transition hover:text-brand-primary disabled:opacity-50"
                >
                  <X size={13} />
                  Remove
                </button>
              )}
            </div>

            {/* A plain <img>, not next/image: the URL can be any host an admin
                pastes, and next/image refuses a domain that is not in
                next.config.ts — which would make the preview fail exactly when
                it is most worth having. */}
            {post.cover_image_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={post.cover_image_url}
                alt={post.cover_image_alt || "Cover image preview"}
                className="mt-2 aspect-[16/9] w-full rounded-xl border border-slate-200 bg-slate-50 object-cover"
              />
            )}
          </Field>

          <Field
            label="Cover image alt text"
            hint="What the image shows, for screen readers and for Google Images."
          >
            <input
              value={post.cover_image_alt}
              onChange={(e) => set("cover_image_alt", e.target.value)}
              className={inputClass}
            />
          </Field>

          <Field label="Tags" hint="Comma separated.">
            <input
              value={post.tags.join(", ")}
              onChange={(e) =>
                set(
                  "tags",
                  e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                )
              }
              className={inputClass}
            />
          </Field>

          <Field label="Author">
            <input
              value={post.author}
              onChange={(e) => set("author", e.target.value)}
              className={inputClass}
            />
          </Field>

          {/* ── Search appearance ───────────────────── */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Search appearance
            </p>

            <button
              onClick={handleGenerateSeo}
              disabled={busy}
              className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-900 bg-white px-4 py-2 text-[13px] font-medium text-slate-900 transition hover:bg-slate-900 hover:text-white disabled:opacity-50"
            >
              {seoLoading ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Drafting…
                </>
              ) : (
                <>
                  <Search size={14} />
                  Draft SEO with AI
                </>
              )}
            </button>
            <p className="mb-4 text-[11px] leading-relaxed text-slate-400">
              Fills the fields below from the article. It replaces whatever is
              there, and saves nothing until you press Save.
            </p>

            <Field
              label="Meta title"
              hint="Leave blank to use the post title."
              right={<CharCount value={post.meta_title} max={META_TITLE_MAX} />}
            >
              <input
                value={post.meta_title}
                onChange={(e) => setSeoField("meta_title", e.target.value)}
                className={inputClass}
              />
            </Field>

            <div className="h-4" />

            <Field
              label="Meta description"
              hint="Leave blank to use the excerpt."
              right={<CharCount value={post.meta_description} max={META_DESC_MAX} />}
            >
              <textarea
                value={post.meta_description}
                onChange={(e) => setSeoField("meta_description", e.target.value)}
                rows={3}
                className={inputClass}
              />
            </Field>

            <div className="h-4" />

            <Field
              label="Focus keyword"
              hint="The one search phrase this article should rank for."
            >
              <input
                value={post.focus_keyword}
                onChange={(e) => setSeoField("focus_keyword", e.target.value)}
                placeholder="title insurance ontario"
                className={inputClass}
              />
            </Field>

            <label className="mt-4 flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={post.noindex}
                onChange={(e) => set("noindex", e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-brand-primary"
              />
              <span>
                <span className="text-[12.5px] font-semibold text-slate-700">
                  Hide from search engines
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed text-slate-400">
                  Keeps the post out of the sitemap and adds a noindex tag. It
                  stays visible to anyone with the link.
                </span>
              </span>
            </label>
          </div>

          {/* ── FAQ ─────────────────────────────────────
              These render on the article AND are submitted as FAQPage
              structured data, which is what an AI Overview quotes. Google
              treats markup describing content a visitor cannot see as a
              manual-action-grade violation, so there is no way to add one here
              without it also appearing on the page. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                FAQ
              </p>
              <button
                onClick={() =>
                  setPost((p) => ({ ...p, faq: [...p.faq, { question: "", answer: "" }] }))
                }
                className="inline-flex items-center gap-1 text-xs font-semibold text-brand-primary hover:text-brand-primaryHover"
              >
                <Plus size={13} />
                Add
              </button>
            </div>
            <p className="mb-4 text-[11px] leading-relaxed text-slate-400">
              Shown on the article and submitted as structured data. Every
              answer must be supported by the article itself.
            </p>

            {post.faq.length === 0 ? (
              <p className="text-[12.5px] text-slate-400">
                No questions yet. Draft SEO with AI, or add one by hand.
              </p>
            ) : (
              <div className="space-y-4">
                {post.faq.map((item, i) => (
                  <div key={i} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                        Q{i + 1}
                      </span>
                      <button
                        onClick={() =>
                          setPost((p) => ({
                            ...p,
                            faq: p.faq.filter((_, n) => n !== i),
                            seo_source: reviewedSeo(p.seo_source),
                          }))
                        }
                        aria-label={`Remove question ${i + 1}`}
                        className="text-slate-300 transition hover:text-brand-primary"
                      >
                        <X size={14} />
                      </button>
                    </div>
                    <input
                      value={item.question}
                      onChange={(e) => setFaqItem(i, { question: e.target.value })}
                      placeholder="What does title insurance actually cover?"
                      className={`${inputClass} mb-2`}
                    />
                    <textarea
                      value={item.answer}
                      onChange={(e) => setFaqItem(i, { answer: e.target.value })}
                      rows={3}
                      placeholder="Two or three sentences, drawn from the article."
                      className={inputClass}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
