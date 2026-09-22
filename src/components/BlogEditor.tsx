"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Sparkles,
  Loader2,
  AlertTriangle,
  Search,
  Plus,
  X,
  ArrowLeft,
  CheckCircle2,
  Upload,
  ImagePlus,
} from "lucide-react";
import BlogRichTextEditor from "./blog/BlogRichTextEditor";
import { detectAuthorFromHtml } from "@/lib/blogAuthor";
import { editorHtmlToSourceText, plainTextToHtml } from "./blog/blogEditorText";

/**
 * Create / edit screen for one blog post.
 *
 * ── One article box ─────────────────────────────────────────────────────
 * The article lives in a single rich-text editor (BlogRichTextEditor), and
 * what is in it is exactly what gets published. There used to be two boxes —
 * a plain-text draft and a read-only "formatted article" beneath it — which
 * meant the admin edited one and published the other, and every correction
 * after formatting had to be made in raw HTML.
 *
 * `content_html` is therefore the only copy of the article this screen holds.
 * The `content_source` column is still written on save, derived from the
 * editor, because the AI steps and the portal both want the words without the
 * markup — but it is no longer something anyone types into.
 *
 * Two ways to fill it, both ending in the same editor:
 *
 *   Write/paste  type into the editor, or paste from Word — ProseMirror
 *                coerces the markup into the allowed tags on the way in.
 *   Upload       drop in the .docx/.pdf/.md/.txt/.html the article was written
 *                in and POST /api/admin/blog/import does the extraction, the
 *                formatting and the search metadata in one round trip.
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

/**
 * A row from GET /api/admin/blog/[id], mapped onto the editor's shape.
 *
 * Carries one piece of history. Before the article became a single rich-text
 * box, a draft could sit in the table with its raw text in `content_source`
 * and `content_html` still empty — the author had pasted it but never pressed
 * Format with AI. Opening such a row against an editor that reads only
 * `content_html` would show an empty page, and saving it would then overwrite
 * the one copy of the text that existed. So the raw text is promoted into
 * paragraphs on the way in, which is lossless and leaves Format with AI able
 * to do its job afterwards.
 */
export function toEditorPost(row: Record<string, unknown>): EditorPost {
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);

  const storedHtml = str(row.content_html);
  const storedSource = str(row.content_source);

  return {
    id: str(row.id) || null,
    slug: str(row.slug),
    status: str(row.status, "draft"),
    title: str(row.title),
    // Every nullable column has to arrive as a string: the inputs are all
    // controlled, and a null turns one into an uncontrolled input that React
    // warns about on the first keystroke.
    excerpt: str(row.excerpt),
    content_html: storedHtml || plainTextToHtml(storedSource),
    content_source: storedSource,
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

/**
 * Whether the FAQ editor is shown at all.
 *
 * Off since the articles started arriving with their FAQ written into the
 * body — an "FAQ" heading with the questions under it, like any other
 * section. A second, separate list of questions in the sidebar would then be
 * published on top of that one, and the reader would scroll past the same
 * three answers twice.
 *
 * Kept in the file rather than deleted: the stored `faq` column is untouched
 * (rows that already have questions keep them and still render), and the day
 * the FAQ goes back to being structured data rather than prose, this is one
 * word. While it is off, nothing WRITES to `post.faq` either — see the two
 * guards on the AI paths below, without which the model would quietly refill
 * a list no one on this screen can see.
 */
const SHOW_FAQ_EDITOR: boolean = false;

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

  // Re-read on every change to the article, so the name appears as soon as
  // the byline is pasted in. Pure string work over the body — cheap enough to
  // do inline.
  const detectedAuthor = useMemo(
    () => detectAuthorFromHtml(post.content_html),
    [post.content_html],
  );

  /**
   * Whether a human has typed in the Author field during this session.
   *
   * The field fills itself from the article (below), and this is what stops
   * it from doing so a second time over a name the admin chose. Without it,
   * an admin who deliberately credits the Law Desk on an article that carries
   * a lawyer's byline would watch the field change back under them.
   */
  const authorTouched = useRef(false);

  /**
   * Fill the Author field from the article.
   *
   * Only while the field is still holding a value nobody chose — empty, or
   * the house default a new post starts with. A name already typed, or one
   * loaded from a saved post that differs, is left alone and offered as a
   * prompt next to the field instead.
   *
   * Nothing is saved by this. It changes what is on screen, and Save is still
   * a press away, which is the same rule every AI step on this screen follows.
   */
  useEffect(() => {
    if (!detectedAuthor || authorTouched.current) return;

    setPost((p) => {
      const current = p.author.trim();
      const unchosen = current === "" || current === EMPTY_POST.author;
      if (!unchosen || current === detectedAuthor.name) return p;
      return { ...p, author: detectedAuthor.name };
    });
  }, [detectedAuthor]);

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

    if (post.content_html.trim()) {
      setError(
        "This post already has an article in it. Clear the editor first, or start a new post — importing replaces everything in it.",
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
      // The Author field is not set here: putting the imported HTML into the
      // post is enough, and the effect above fills the name from it. One rule
      // for every way the article arrives — upload, paste or typing.
      const importedHtml = json.html || plainTextToHtml(json.text ?? "");

      setPost((p) => ({
        ...p,
        title: json.title || p.title,
        // If the formatting step failed the server still returns the extracted
        // text, so it goes into the editor as plain paragraphs rather than
        // being thrown away with the error. Format with AI can be pressed after.
        content_html: importedHtml,
        format_source: json.formatSource ?? "manual",
        ...(seo
          ? {
              meta_title: seo.metaTitle ?? p.meta_title,
              meta_description: seo.metaDescription ?? p.meta_description,
              excerpt: seo.excerpt || p.excerpt,
              focus_keyword: seo.focusKeyword ?? p.focus_keyword,
              tags: seo.tags?.length ? seo.tags : p.tags,
              faq: SHOW_FAQ_EDITOR ? seo.faq ?? p.faq : p.faq,
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

  /**
   * Re-marks-up whatever is in the editor: headings, paragraphs, lists.
   *
   * It reads the editor's content back out as plain text first. Sending the
   * HTML instead would break the check that gives this route its point —
   * formatBlogHtml() measures how much of the author's wording survived, and
   * with HTML on the "before" side every tag name counts as a word the model
   * is then found to have dropped.
   */
  async function handleFormat() {
    setError(null);
    setNotice(null);
    setWarnings([]);

    const body = editorHtmlToSourceText(post.content_html).trim();
    if (!body) {
      setError("Write or upload the article first.");
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

    const body = post.content_html.trim();
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
        faq: SHOW_FAQ_EDITOR ? seo.faq ?? p.faq : p.faq,
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
        // Derived, never typed: the words without the markup, which is what the
        // AI steps and the portal read. Recomputed on every save so it cannot
        // drift from the article it is supposed to describe — but never
        // narrowed to nothing, because saving a post whose body is still empty
        // would otherwise erase the stored text on its way past.
        content_source:
          editorHtmlToSourceText(post.content_html) || post.content_source,
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

          {/* ── The article ─────────────────────────────
              One box. The two buttons that can fill or reshape it sit on top
              of it, and both write into the same editor the admin then edits.
              Neither saves anything. */}
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <label className="text-[12.5px] font-semibold text-slate-700">Article</label>

              <div className="flex flex-wrap items-center gap-2">
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
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-[13px] font-medium text-slate-700 transition hover:border-slate-300 disabled:opacity-50"
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

                <button
                  onClick={handleFormat}
                  disabled={busy}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  {formatting ? (
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
              </div>
            </div>

            <BlogRichTextEditor
              value={post.content_html}
              disabled={busy}
              onChange={(html) =>
                setPost((p) =>
                  html === p.content_html
                    ? p
                    : {
                        ...p,
                        content_html: html,
                        // Any hand edit means a human has been through it.
                        format_source:
                          p.format_source === "gemini" ? "gemini_edited" : p.format_source,
                      },
                )
              }
            />

            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
              Type here, paste from Word, or upload the document it was written
              in — Word (.docx), PDF, Markdown, plain text or HTML, up to 10 MB.
              An upload is formatted and written up for search in one pass.
              Format with AI re-marks-up whatever is in the box: it adds the
              headings, paragraphs and lists, and does not change your words.
            </p>

            {importing && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                A long PDF can take up to a minute. Leave this tab open.
              </p>
            )}
          </div>
        </div>

        {/* ── Right: metadata ────────────────────────── */}
        <div className="space-y-5">
          {/* ── Search appearance ─────────────────────
              First in the column, because the meta title and description are
              what a post is actually judged on in a search result, and burying
              them under the image and tag fields meant they were the thing
              most often left on the AI's first draft. The remaining search
              settings are in "Search options" at the bottom. */}
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
              Fills these two, the excerpt, the tags and the focus keyword from
              the article. It replaces whatever is there, and saves nothing
              until you press Save.
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
          </div>

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

          <Field
            label="Author"
            hint="Printed under the title and submitted as the article's author in structured data."
          >
            <input
              value={post.author}
              onChange={(e) => {
                // From here on the field is the admin's, and the article stops
                // filling it — see authorTouched.
                authorTouched.current = true;
                set("author", e.target.value);
              }}
              className={inputClass}
            />

            {/* Filled from the article, and said so. Silent auto-fill of a
                field that is published under someone's name is the kind of
                thing that should be visible on the screen it happened on. */}
            {detectedAuthor && detectedAuthor.name === post.author.trim() && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-green-700">
                Taken from the article ({detectedAuthor.source}).
              </p>
            )}

            {/* The article states its own author — in the byline under the
                title, and again in "About the author" at the foot. When that
                name is not the one in the field, the page credits one person
                and the words beneath it credit another. Offered rather than
                applied here: the field holds a name someone chose, and a pen
                name or a guest post is a real thing. */}
            {detectedAuthor && detectedAuthor.name !== post.author.trim() && (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <span className="text-[11.5px] leading-relaxed text-amber-900">
                  The article says <strong>{detectedAuthor.name}</strong>{" "}
                  <span className="text-amber-700">({detectedAuthor.source})</span>
                </span>
                <button
                  onClick={() => set("author", detectedAuthor.name)}
                  className="ml-auto shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-amber-900 transition hover:border-amber-400"
                >
                  Use it
                </button>
              </div>
            )}
          </Field>

          {/* ── Search options ───────────────────────
              The rest of the search settings. The two fields that are edited
              on nearly every post — meta title and meta description — sit at
              the top of this column instead; these two are set once and
              rarely revisited, so they live down here out of the way. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Search options
            </p>

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
              Switched off, not deleted — see SHOW_FAQ_EDITOR above.

              These render on the article AND are submitted as FAQPage
              structured data, which is what an AI Overview quotes. Google
              treats markup describing content a visitor cannot see as a
              manual-action-grade violation, so there is no way to add one here
              without it also appearing on the page. */}
          {SHOW_FAQ_EDITOR && (
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
          )}
        </div>
      </div>
    </div>
  );
}
