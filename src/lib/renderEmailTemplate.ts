// Safe placeholder substitution for admin-authored email templates (SEC-009).
//
// The old renderers substituted `{{ placeholder }}` values with a *sequence* of
// String.replaceAll / .replace passes over the whole body. That had two flaws:
//
//   1. Reflective injection — a user-controlled field (a lead's name, address,
//      notes…) whose value itself contained a placeholder string like
//      "{{ user.email }}" would get re-substituted by a LATER pass, letting one
//      field's value pull in another field's value.
//   2. HTML injection — values were spliced into the HTML body verbatim, so a
//      value like "<img src=x onerror=…>" landed as live markup.
//
// This renderer fixes both:
//   • SINGLE PASS. `String.prototype.replace` with a global regex + function
//     replacer scans the ORIGINAL string once, left to right, and never
//     re-examines the text it just inserted. So a substituted value that happens
//     to contain "{{ … }}" is inert — reflective injection is structurally
//     impossible, no matter what a value contains.
//   • HTML-ESCAPED values. Every substituted value is HTML-escaped by default, so
//     it can only ever render as text, never as markup. Trusted, system-generated
//     values that are *meant* to be raw (auth links, pre-built HTML rows) opt out
//     per-token via `{ raw: true }`.
//
// Template STRUCTURE (the surrounding HTML the admin authored) is never touched —
// only the matched `{{ … }}` tokens are replaced — so existing template markup
// and entities pass through unchanged.

export type TemplateValue = {
  /** The resolved value to substitute. */
  value: string;
  /** When true, substitute verbatim (no HTML-escaping). Use ONLY for trusted,
   *  system-generated values such as auth links — never for user data. */
  raw?: boolean;
};

/**
 * GAP-013: normalize the various ways rich-text editors encode the placeholder
 * braces `{ }` (and non-breaking spaces) back to plain characters, so
 * `{{ ... }}` placeholders are always recognized before substitution — decimal
 * (`&#123;`), hex (`&#x7B;`, either case), and named (`&lbrace;`) forms.
 *
 * We deliberately do NOT decode content entities like `&amp;` / `&lt;` / `&gt;`:
 * those are VALID HTML in the email body, and decoding them would corrupt the
 * markup (or let `&lt;script&gt;` become a live tag). Only the braces that gate
 * placeholder detection — and `&nbsp;` — are normalized here.
 */
export function decodeTemplateBraces(html: string): string {
  return html
    .replace(/&#123;|&#x7b;|&lbrace;/gi, "{")
    .replace(/&#125;|&#x7d;|&rbrace;/gi, "}")
    .replace(/&nbsp;/gi, " ")
    .replace(/ /g, " ");
}

/** HTML-escape a value so it can only render as text, never as markup. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render `{{ placeholder }}` tokens in `text` in a single pass.
 *
 * @param resolve  Called once per token with the trimmed placeholder name (e.g.
 *                 "user.first_name"). Return the value to substitute, or `null`
 *                 to leave the token untouched (unknown placeholders are left
 *                 verbatim, matching the previous behaviour).
 * @param opts.escape  HTML-escape substituted values (default true). Pass false
 *                     for plain-text contexts like the email SUBJECT line, where
 *                     "&amp;" would show literally. Reflective-injection safety
 *                     (single pass) applies regardless of this flag.
 */
export function renderTemplateSafe(
  text: string,
  resolve: (name: string) => TemplateValue | null,
  opts: { escape?: boolean } = {},
): string {
  const escape = opts.escape !== false;
  // [^{}] so a token can't span an intervening brace; trims surrounding space.
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (match, rawName: string) => {
    const resolved = resolve(rawName.trim());
    if (!resolved) return match; // unknown placeholder → leave as-is
    return escape && !resolved.raw ? escapeHtml(resolved.value) : resolved.value;
  });
}
