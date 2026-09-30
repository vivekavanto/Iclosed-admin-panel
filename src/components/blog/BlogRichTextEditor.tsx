"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Quote,
  Link2,
  Link2Off,
  Minus,
  Undo2,
  Redo2,
  Code2,
  Eye,
} from "lucide-react";
import { ARTICLE_BODY_CLASS } from "./articleBodyClass";

/**
 * The article editor: one box that is both the thing you type into and the
 * thing the post will look like.
 *
 * It replaced a pair of boxes — a plain-text draft and a separate read-only
 * "formatted article" preview — which meant the admin edited one and published
 * the other, and every fix had to be made twice or made in HTML.
 *
 * ── The schema IS the sanitizer's allowlist ─────────────────────────────
 * The extensions below are configured so the editor cannot produce a tag that
 * sanitizeBlogHtml() would strip. That is not belt-and-braces; it is the
 * difference between an editor you can trust and one that silently discards
 * work on save. Headings are restricted to h2-h4 because the page renders the
 * post title as the sole h1, and a pasted h1 is demoted rather than dropped.
 *
 * It also fixes the paste problem, which is the realistic way content arrives
 * here: ProseMirror coerces pasted Word/Google Docs markup into these node
 * types on the way in, so the spans, inline styles and empty divs never make
 * it into the document at all.
 *
 * Sanitizing still happens on save (src/lib/blogPosts.ts) and on render
 * (BlogArticleBody). This narrows what can be authored; it does not replace
 * either of them, because the source view below lets an admin type raw HTML.
 */

const TIPTAP_EXTENSIONS = [
  StarterKit.configure({
    // h1 is not in the sanitizer's allowlist: the page renders the post title
    // as the sole h1, and a second one in the body is a real SEO problem.
    heading: { levels: [2, 3, 4] },
    link: {
      openOnClick: false,
      // The sanitizer rewrites outbound links to nofollow/noopener/_blank on
      // the way out, so nothing is set here beyond restricting the schemes.
      protocols: ["http", "https", "mailto", "tel"],
      HTMLAttributes: { rel: null, target: null },
    },
  }),
];

function ToolbarButton({
  onClick,
  active,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      // The editor loses its selection the moment a button takes focus, which
      // makes every command apply to nothing.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`rounded-lg p-1.5 transition disabled:opacity-30 ${
        active
          ? "bg-slate-900 text-white"
          : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <span className="mx-0.5 h-5 w-px bg-slate-200" aria-hidden />;
}

function Toolbar({
  editor,
  disabled,
  onShowSource,
}: {
  editor: Editor;
  disabled: boolean;
  onShowSource: () => void;
}) {
  // ProseMirror state changes do not re-render React on their own, so the
  // active states below would freeze on whatever they were at mount.
  const [, force] = useState(0);
  useEffect(() => {
    const bump = () => force((n) => n + 1);
    editor.on("transaction", bump);
    editor.on("selectionUpdate", bump);
    return () => {
      editor.off("transaction", bump);
      editor.off("selectionUpdate", bump);
    };
  }, [editor]);

  const setLink = useCallback(() => {
    const previous = editor.getAttributes("link").href as string | undefined;
    const href = window.prompt("Link URL", previous ?? "https://");

    // Cancel leaves the document alone; clearing the box removes the link.
    if (href === null) return;
    if (!href.trim()) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor
      .chain()
      .focus()
      .extendMarkRange("link")
      .setLink({ href: href.trim() })
      .run();
  }, [editor]);

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-slate-200 bg-slate-50/80 px-2 py-1.5">
      <ToolbarButton
        label="Heading"
        disabled={disabled}
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Sub-heading"
        disabled={disabled}
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 size={15} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        label="Bold"
        disabled={disabled}
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <Bold size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Italic"
        disabled={disabled}
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <Italic size={15} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        label="Bulleted list"
        disabled={disabled}
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        <List size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Numbered list"
        disabled={disabled}
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        <ListOrdered size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Quote"
        disabled={disabled}
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        <Quote size={15} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        label="Add or edit link"
        disabled={disabled}
        active={editor.isActive("link")}
        onClick={setLink}
      >
        <Link2 size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Remove link"
        disabled={disabled || !editor.isActive("link")}
        onClick={() => editor.chain().focus().extendMarkRange("link").unsetLink().run()}
      >
        <Link2Off size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Divider"
        disabled={disabled}
        onClick={() => editor.chain().focus().setHorizontalRule().run()}
      >
        <Minus size={15} />
      </ToolbarButton>

      <Divider />

      <ToolbarButton
        label="Undo"
        disabled={disabled || !editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        <Undo2 size={15} />
      </ToolbarButton>
      <ToolbarButton
        label="Redo"
        disabled={disabled || !editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        <Redo2 size={15} />
      </ToolbarButton>

      <div className="ml-auto">
        <ToolbarButton label="Edit HTML" disabled={disabled} onClick={onShowSource}>
          <Code2 size={15} />
        </ToolbarButton>
      </div>
    </div>
  );
}

export default function BlogRichTextEditor({
  value,
  onChange,
  disabled = false,
  placeholder = "Write the article here, or upload a document above.",
}: {
  value: string;
  onChange: (html: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [showSource, setShowSource] = useState(false);

  /**
   * The last HTML this component sent up.
   *
   * TipTap owns its own document, so `value` cannot simply be pushed into it
   * on every render — that would reset the cursor on every keystroke. Tracking
   * what we emitted is how an EXTERNAL change (an import, a Format with AI, a
   * source-view edit) is told apart from the echo of our own onChange.
   */
  const emitted = useRef(value);

  const editor = useEditor({
    extensions: TIPTAP_EXTENSIONS,
    content: value,
    editable: !disabled,
    // Required in the App Router: rendering on the server produces markup the
    // client then disagrees with, and React throws a hydration error.
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: `${ARTICLE_BODY_CLASS} min-h-[420px] px-6 py-5 outline-none`,
      },
    },
    onUpdate: ({ editor: e }) => {
      const html = e.isEmpty ? "" : e.getHTML();
      emitted.current = html;
      onChange(html);
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (value === emitted.current) return;

    emitted.current = value;
    // emitUpdate false: this content came FROM the parent, and echoing it back
    // through onChange would fight whatever set it.
    editor.commands.setContent(value || "", { emitUpdate: false });
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) {
    // Matches the mounted height so the page does not jump on hydration.
    return (
      <div className="min-h-[470px] animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
    );
  }

  return (
    <div
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white transition focus-within:border-brand-primary ${
        disabled ? "opacity-60" : ""
      }`}
    >
      {showSource ? (
        <>
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/80 px-3 py-1.5">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              HTML source
            </span>
            <button
              type="button"
              onClick={() => setShowSource(false)}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
            >
              <Eye size={13} />
              Back to the article
            </button>
          </div>
          <textarea
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            rows={20}
            spellCheck={false}
            className="w-full resize-y bg-white px-4 py-3 font-mono text-[12.5px] leading-relaxed text-slate-900 outline-none"
          />
          <p className="border-t border-slate-100 px-4 py-2 text-[11px] leading-relaxed text-slate-400">
            Anything outside the allowed tags is removed when the post is saved.
          </p>
        </>
      ) : (
        <>
          <Toolbar
            editor={editor}
            disabled={disabled}
            onShowSource={() => setShowSource(true)}
          />
          {/* The placeholder is positioned against the CONTENT area, not the
              whole component — anchored to the outer box it would sit on top
              of the toolbar. */}
          <div className="relative">
            {editor.isEmpty && (
              <p className="pointer-events-none absolute left-6 top-5 text-[15px] text-slate-300">
                {placeholder}
              </p>
            )}
            <EditorContent editor={editor} />
          </div>
        </>
      )}
    </div>
  );
}
