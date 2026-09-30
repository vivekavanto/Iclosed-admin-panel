import sanitizeHtml from "sanitize-html";

/**
 * MIRRORED from the customer portal (iclosed_dev_web/src/lib/sanitizeBlogHtml.ts).
 * Both apps write to the same blog_posts table and both render the result, so
 * the allowlist has to be the same in both places or a tag that survives one
 * write path is stripped by the other read path. Keep the two copies identical.
 *
 * Cleans article HTML before it is rendered into the page.
 *
 * Blog bodies reach the browser through dangerouslySetInnerHTML (see
 * src/components/blog/BlogArticle.tsx), so every string that arrives there has
 * to be assumed hostile. Three sources feed it: a model's output, an admin's
 * pasted HTML, and rows the separate admin app writes straight to the table
 * without passing through this repo's route handlers.
 *
 * Which is why callers sanitize on WRITE *and* on READ. Writing clean HTML
 * keeps the stored copy trustworthy for excerpting and for diffing; sanitizing
 * again on read is what actually protects the render, and is the only thing
 * covering the rows that never went through our write path.
 *
 * sanitize-html rather than DOMPurify: DOMPurify needs a DOM, so using it
 * server-side drags in jsdom. This is plain string-in/string-out and behaves
 * identically in a route handler, in a Server Component and in a Jest test.
 */

// An article, not a web page. No divs, no spans, no styles, no ids, no class
// attributes — the page's own Tailwind child selectors do all the styling, so
// letting authored markup carry classes would just fight them.
const ALLOWED_TAGS = [
  "p", "br", "hr",
  "h2", "h3", "h4",
  "ul", "ol", "li",
  "strong", "em", "b", "i", "u", "s",
  "a",
  "blockquote",
  "figure", "figcaption", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "code", "pre",
];

// h1 is deliberately absent: the page renders the post title as the sole h1,
// and a second one in the body is a real (if minor) SEO problem.

export function sanitizeBlogHtml(html: string | null | undefined): string {
  if (!html) return "";

  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "width", "height", "loading"],
      th: ["colspan", "rowspan", "scope"],
      td: ["colspan", "rowspan"],
    },
    // No `data:` — an inline data: URI is how an SVG payload gets smuggled past
    // a tag allowlist.
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    // Drop the contents of anything disallowed rather than leaving stray text.
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href ?? "";
        // Site-internal links keep their default behaviour: same tab, and no
        // nofollow, because internal linking is exactly what we want crawlers
        // to follow. Only outbound links get the treatment.
        const isInternal =
          href.startsWith("/") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:");

        if (isInternal) return { tagName, attribs };

        return {
          tagName,
          attribs: {
            ...attribs,
            rel: "nofollow noopener noreferrer",
            target: "_blank",
          },
        };
      },
      img: (tagName, attribs) => ({
        tagName,
        attribs: {
          ...attribs,
          // Cover image aside, article images are below the fold by definition.
          loading: "lazy",
          alt: attribs.alt ?? "",
        },
      }),
    },
  });
}

/**
 * Plain text of an article body, for word counts, reading time and for handing
 * a draft to Gemini without spending tokens on markup.
 */
export function blogHtmlToText(html: string | null | undefined): string {
  if (!html) return "";

  // Separate adjacent tags before stripping them. Without this, `</li><li>`
  // has no whitespace between the two words it divides and they are
  // concatenated into one — "fraud" + "and" becomes "fraudand". That silently
  // understates word counts, and it makes verifyWordsPreserved() report
  // invented losses on output that was in fact perfect, which is worse than
  // not checking at all.
  const spaced = html.replace(/></g, "> <");

  const stripped = sanitizeHtml(spaced, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["style", "script", "textarea", "option", "noscript"],
  });
  return stripped.replace(/\s+/g, " ").trim();
}

/** Reading time in whole minutes, floored at 1. ~200 words/minute. */
export function readingTimeFromHtml(html: string | null | undefined): number {
  const words = blogHtmlToText(html).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}
