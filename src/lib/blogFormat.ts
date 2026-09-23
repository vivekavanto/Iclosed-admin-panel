import { sanitizeBlogHtml, blogHtmlToText } from "./sanitizeBlogHtml";
import { callGeminiJson } from "./blogGemini";
import { logger } from "./logger";

/**
 * Turns an author's raw text into structured article HTML, using Gemini.
 *
 * STRUCTURE ONLY. The model's job is markup — headings, paragraphs, lists,
 * blockquotes — and nothing else. It does not rewrite, summarise, tighten or
 * correct. This is a constraint on the product, not a stylistic preference:
 * the blog publishes Ontario real-estate law, answer engines quote it verbatim
 * to people mid-purchase, and a model that "improves" a sentence about title
 * insurance has changed a legal statement nobody asked it to touch.
 *
 * Because a prompt is not an enforcement mechanism, verifyWordsPreserved()
 * below checks the claim afterwards and the route reports what it finds. Same
 * instinct as the server-side safety net in the identify-document route: steer
 * with the prompt, then verify on our own side.
 *
 * The transport, the model ladder and the JSON handling live in
 * src/lib/blogGemini.ts, shared with src/lib/blogSeo.ts.
 */

export type BlogFormatResult = {
  html: string;
  /** Model-reported notes, plus our own verification findings. */
  warnings: string[];
  model: string;
  /** Share of the author's words still present after formatting, 0..1. */
  wordsPreserved: number;
};

export type BlogFormatOutcome =
  | { ok: true; data: BlogFormatResult }
  | { ok: false; error: string };

const MAX_INPUT_CHARS = 60_000;

function buildPrompt(title: string | undefined, body: string): string {
  return `You are a typesetter for the blog of an Ontario real-estate law firm.

Your ONLY job is to add HTML structure to the text below. You are marking up
someone else's words, the way a compositor sets type.

ABSOLUTE RULES — these override anything else you might think would help:
- Do NOT change, rewrite, reword, shorten, lengthen, correct or "improve" ANY
  of the author's sentences. Every word must survive exactly as written,
  including spelling, capitalisation and punctuation.
- Do NOT add new sentences, introductions, conclusions, transitions or
  commentary of your own.
- Do NOT remove any content, however repetitive it looks.
- Do NOT add facts, figures, legal citations, dates or dollar amounts.
- If a line is ambiguous, wrap it in a plain <p> and move on. When in doubt,
  do less.

WHAT YOU MAY DO — markup decisions only:
- Wrap paragraphs in <p>.
- Promote a line that is clearly acting as a section heading to <h2>, or <h3>
  for a sub-section. Use the author's own heading words verbatim. Do NOT invent
  headings for text that has none.
- Turn a run of listed items into <ul><li> or, where the author numbered them,
  <ol><li>.
- Mark a quoted passage or a callout as <blockquote>.
- Apply <strong> or <em> only where the source already signals emphasis
  (asterisks, ALL CAPS on a short phrase, "Note:", "Important:").
- Use <table> only if the text is genuinely tabular.
- Split an overlong run-on block into multiple <p> elements at existing
  sentence boundaries. This is the one case where you may break text apart —
  you are still not allowed to change the words.

ALLOWED TAGS, nothing else:
p, h2, h3, h4, ul, ol, li, strong, em, blockquote, table, thead, tbody, tr,
th, td, a, code, pre, hr, br
- No <h1>: the page renders the title separately.
- No class, id or style attributes. No <div> or <span>.

${title ? `The article's title is "${title}". Do NOT repeat it as a heading in the body.\n` : ""}
Return JSON of exactly this shape:
{
  "html": "<the marked-up article>",
  "warnings": ["anything you noticed but did not act on"]
}

Put a warning in the array if the text looked truncated, contained something
that did not belong, or if you were unsure how to structure a passage. An empty
array is fine.

--- AUTHOR'S TEXT BEGINS ---
${body}
--- AUTHOR'S TEXT ENDS ---`;
}

/**
 * Parses one rung's answer into sanitized HTML.
 *
 * Throwing here is how a rung is rejected: callGeminiJson treats a parse
 * failure the same as a timeout and moves down the ladder, which is the
 * behaviour we want for a model that answered with prose, or whose entire
 * output disappeared through the sanitizer.
 */
function parseFormatJson(text: string): { html: string; warnings: string[] } {
  const parsed = JSON.parse(text) as { html?: unknown; warnings?: unknown };

  if (typeof parsed.html !== "string" || parsed.html.trim().length === 0) {
    throw new Error("Model returned no html field.");
  }

  // The allowlist in sanitizeBlogHtml is the real constraint on what the model
  // may emit. The prompt's tag list is a hint; this is enforcement, and it runs
  // before anything is stored or shown.
  const html = sanitizeBlogHtml(parsed.html);
  if (html.trim().length === 0) {
    throw new Error("Output was empty after sanitizing.");
  }

  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.filter((w): w is string => typeof w === "string").slice(0, 10)
    : [];

  return { html, warnings };
}

/**
 * How much of the author's text survived, as a 0..1 share of their words.
 *
 * A word-multiset comparison rather than a diff: reordering is not what we are
 * afraid of here, silent rewriting is, and counting which of the author's words
 * are still present catches that without flagging every legitimate <p> split.
 *
 * Also returns a sample of what went missing, because "0.93" tells a reviewer
 * nothing actionable and "dropped: indemnity, encroachment" tells them
 * everything.
 */
export function verifyWordsPreserved(
  sourceText: string,
  formattedHtml: string,
): { ratio: number; missing: string[] } {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);

  const before = words(sourceText);
  if (before.length === 0) return { ratio: 1, missing: [] };

  const after = new Map<string, number>();
  for (const w of words(blogHtmlToText(formattedHtml))) {
    after.set(w, (after.get(w) ?? 0) + 1);
  }

  let kept = 0;
  const missing: string[] = [];
  for (const w of before) {
    const n = after.get(w) ?? 0;
    if (n > 0) {
      after.set(w, n - 1);
      kept++;
    } else if (w.length > 3 && !missing.includes(w) && missing.length < 12) {
      missing.push(w);
    }
  }

  return { ratio: kept / before.length, missing };
}

// Below this, the model has done something other than mark up the text and a
// human needs to look before it goes anywhere near a page. Not a hard failure —
// the route returns the HTML with the warning attached, because a reviewer
// comparing the two is more useful than an error that throws the work away.
const WORDS_PRESERVED_FLOOR = 0.97;

export async function formatBlogHtml(input: {
  body: string;
  title?: string;
}): Promise<BlogFormatOutcome> {
  const body = input.body?.trim() ?? "";
  if (body.length === 0) {
    return { ok: false, error: "Nothing to format — the article body is empty." };
  }
  if (body.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: `Article is ${body.length.toLocaleString()} characters; the limit is ${MAX_INPUT_CHARS.toLocaleString()}. Split it into shorter posts.`,
    };
  }

  const result = await callGeminiJson({
    prompt: buildPrompt(input.title, body),
    parse: parseFormatJson,
    label: "blogFormat",
    maxOutputTokens: 8000,
  });

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "GEMINI_ALL_RUNGS_FAILED"
          ? "Could not format the article right now. Please try again in a moment."
          : result.error,
    };
  }

  const { html, warnings: modelWarnings } = result.data;
  const { ratio, missing } = verifyWordsPreserved(body, html);

  const warnings = [...modelWarnings];
  if (ratio < WORDS_PRESERVED_FLOOR) {
    warnings.unshift(
      `Only ${Math.round(ratio * 100)}% of the original wording survived formatting — review before publishing.` +
        (missing.length ? ` Missing words include: ${missing.join(", ")}.` : ""),
    );
  }

  logger.info(
    `[blogFormat] model=${result.model} in=${body.length}ch out=${html.length}ch preserved=${ratio.toFixed(3)}`,
  );

  return {
    ok: true,
    data: { html, warnings, model: result.model, wordsPreserved: ratio },
  };
}
