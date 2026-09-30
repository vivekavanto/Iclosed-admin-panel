/**
 * Converting between the editor's HTML and the plain text the AI steps work on.
 *
 * BROWSER ONLY. Both functions use DOMParser, so this must not be imported
 * from a route handler. That is deliberate rather than an oversight: the
 * server-side equivalent, blogHtmlToText() in src/lib/sanitizeBlogHtml.ts,
 * flattens an article to a single run of words for counting, which is the
 * wrong output here.
 *
 * ── Why not just send the HTML to /api/admin/blog/format ────────────────
 * Because formatBlogHtml() calls verifyWordsPreserved(body, html) to check
 * that the model changed none of the author's words. Handing it HTML as the
 * "before" side makes every tag name a word the model is then found to have
 * dropped, and a perfect formatting run reports itself as ~60% preserved. The
 * metric is the whole point of that route, so the text has to be text.
 *
 * ── Why Markdown-ish markers ────────────────────────────────────────────
 * The format prompt is forbidden from inventing headings for text that has
 * none. Round-tripping through flat text would therefore demote every heading
 * and list in the article to a paragraph, permanently, the first time someone
 * pressed Format with AI on already-structured content. The `##` and `-`
 * markers carry that structure across and are ignored by
 * verifyWordsPreserved(), which counts alphanumeric words only.
 *
 * This is the same representation src/lib/blogImport.ts produces from a .docx,
 * so an uploaded document and an edited article reach Gemini in one shape.
 */

const HEADING_PREFIX: Record<string, string> = {
  H1: "## ", // h1 never reaches a body, but demote rather than drop if it does.
  H2: "## ",
  H3: "### ",
  H4: "#### ",
  H5: "#### ",
  H6: "#### ",
};

/** The text of one block, with inline tags flattened and whitespace collapsed. */
function inlineText(el: Element): string {
  return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

/**
 * The editor's content as the plain text the author would have typed.
 *
 * Walks top-level blocks only. Nested lists are flattened to a single level,
 * which matches what the sanitizer and the published styling support anyway.
 */
export function editorHtmlToSourceText(html: string): string {
  if (!html || !html.trim()) return "";

  const doc = new DOMParser().parseFromString(html, "text/html");
  const lines: string[] = [];

  const walk = (node: Element) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toUpperCase();

      if (HEADING_PREFIX[tag]) {
        const text = inlineText(el);
        if (text) lines.push(`${HEADING_PREFIX[tag]}${text}`);
        continue;
      }

      switch (tag) {
        case "UL":
        case "OL": {
          for (const li of Array.from(el.children)) {
            // Only this item's own text, not its nested list's — those are
            // emitted by the recursive walk below as items of their own.
            const own = Array.from(li.childNodes)
              .filter((n) => !(n instanceof Element && /^(UL|OL)$/.test(n.tagName)))
              .map((n) => n.textContent ?? "")
              .join("")
              .replace(/\s+/g, " ")
              .trim();
            if (own) lines.push(`- ${own}`);
            walk(li as Element);
          }
          break;
        }
        case "BLOCKQUOTE": {
          const text = inlineText(el);
          if (text) lines.push(`> ${text}`);
          break;
        }
        case "HR":
          lines.push("---");
          break;
        case "TABLE":
        case "FIGURE":
        case "PRE": {
          const text = inlineText(el);
          if (text) lines.push(text);
          break;
        }
        default: {
          const text = inlineText(el);
          if (text) lines.push(text);
        }
      }
    }
  };

  walk(doc.body);

  // A blank line between blocks: it is what tells the model where one
  // paragraph ends and the next begins.
  return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Plain text as the simplest possible article HTML: one paragraph per block.
 *
 * The fallback for when formatting is unavailable — an import whose Gemini
 * step failed, or a paste into the source view. It invents no structure, so a
 * later Format with AI still has everything to work with, and the author's
 * words are on screen and editable rather than lost with the error.
 */
export function plainTextToHtml(text: string): string {
  if (!text || !text.trim()) return "";

  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
