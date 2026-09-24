import { blogHtmlToText } from "./sanitizeBlogHtml";
import { callGeminiJson } from "./blogGemini";
import { logger } from "./logger";

/**
 * Drafts the search-and-answer-engine metadata for one post, using Gemini:
 * meta title, meta description, excerpt, focus keyword, tags, and the FAQ that
 * becomes FAQPage JSON-LD.
 *
 * The opposite constraint from src/lib/blogFormat.ts, and worth being explicit
 * about. Formatting is markup only — the model may not change a single word,
 * because answer engines quote this firm's legal copy verbatim. Here the model
 * IS writing new sentences, because that is what a meta description is. So the
 * risk moves rather than disappearing: not "did it rewrite the author's words"
 * but "did it invent a fact the article never claimed".
 *
 * Hence verifyGrounding() below. A prompt is not an enforcement mechanism, so
 * every figure, dollar amount, percentage and date in the generated copy is
 * checked against the article text, and anything that does not appear there is
 * reported to the admin as a warning. Same instinct as verifyWordsPreserved():
 * steer with the prompt, then verify on our own side.
 *
 * Nothing here is ever auto-published. The route stores nothing; the admin
 * reviews what comes back and saves it themselves, and `seo_source` records
 * that the copy started as machine output. See the portal repo’s
 * sql/create_blog_posts.sql for that column.
 */

/** Google truncates past roughly these; the editor shows the same numbers. */
export const META_TITLE_MAX = 60;
export const META_DESC_MAX = 155;
const EXCERPT_MAX = 220;
const MAX_INPUT_CHARS = 300_000;

export type BlogSeoFields = {
  metaTitle: string;
  metaDescription: string;
  excerpt: string;
  focusKeyword: string;
  tags: string[];
  faq: { question: string; answer: string }[];
};

export type BlogSeoResult = BlogSeoFields & {
  /** Model-reported notes, plus our own grounding findings. */
  warnings: string[];
  model: string;
};

export type BlogSeoOutcome =
  | { ok: true; data: BlogSeoResult }
  | { ok: false; error: string };

function buildPrompt(title: string, articleText: string): string {
  return `You are an SEO editor for the blog of an Ontario real-estate law firm.

You are writing the search metadata for the article below. Unlike the body of
the article, this copy is yours to write — but every claim in it must come from
the article itself.

ABSOLUTE RULES:
- Do NOT state any fact, figure, dollar amount, percentage, deadline, tax rate
  or legal rule that does not already appear in the article text.
- Do NOT give legal advice, make guarantees, or use words like "guaranteed",
  "always", "never", "best" or "#1". This is a regulated profession and the
  Law Society governs how it may advertise.
- Do NOT invent statistics, awards, client numbers or testimonials.
- Write in Canadian English, for a homebuyer or seller in Ontario.
- No clickbait, no ALL CAPS, no emoji, no exclamation marks.

WHAT TO PRODUCE:
- "metaTitle": what Google prints as the blue link. At most ${META_TITLE_MAX}
  characters INCLUDING spaces. Lead with what the reader is searching for. Do
  not append the firm name — the page template does not add one either, so the
  whole ${META_TITLE_MAX} characters are yours.
- "metaDescription": the grey text under the link. At most ${META_DESC_MAX}
  characters INCLUDING spaces. One or two plain sentences saying what the
  reader will learn. Not a summary of the firm.
- "excerpt": the blurb shown on our own blog listing page, at most
  ${EXCERPT_MAX} characters. Warmer and more human than the meta description;
  they should not be identical.
- "focusKeyword": the single search phrase this article should rank for, two to
  five words, as a person would actually type it.
- "tags": three to five short topic labels, Title Case, e.g. "Title Insurance",
  "Closing Costs", "First-Time Buyers".
- "faq": three to five questions a reader genuinely asks about this topic,
  each ANSWERED FROM THE ARTICLE in two or three sentences. These are published
  on the page and submitted as structured data, so an answer that is not
  supported by the article text is the single worst thing you can return here.
  If the article does not support three questions, return fewer. An empty list
  is better than an invented answer.
- "warnings": anything you noticed but did not act on — the article seemed
  truncated, it did not support a decent FAQ, the topic was too thin to target
  a keyword. An empty array is fine.

The article's title is: ${title || "(untitled)"}

Return JSON of exactly this shape, and nothing else:
{
  "metaTitle": "...",
  "metaDescription": "...",
  "excerpt": "...",
  "focusKeyword": "...",
  "tags": ["...", "..."],
  "faq": [{ "question": "...", "answer": "..." }],
  "warnings": []
}

--- ARTICLE TEXT BEGINS ---
${articleText}
--- ARTICLE TEXT ENDS ---`;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asStringArray(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseSeoJson(raw: string): BlogSeoFields & { warnings: string[] } {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const metaTitle = asString(parsed.metaTitle);
  const metaDescription = asString(parsed.metaDescription);
  if (!metaTitle || !metaDescription) {
    throw new Error("Model returned no metaTitle/metaDescription.");
  }

  const faq = Array.isArray(parsed.faq)
    ? parsed.faq
        .map((item) => {
          const o = (item ?? {}) as Record<string, unknown>;
          return { question: asString(o.question), answer: asString(o.answer) };
        })
        .filter((q) => q.question && q.answer)
        .slice(0, 6)
    : [];

  return {
    metaTitle,
    metaDescription,
    excerpt: asString(parsed.excerpt),
    focusKeyword: asString(parsed.focusKeyword),
    tags: asStringArray(parsed.tags, 6),
    faq,
    warnings: asStringArray(parsed.warnings, 10),
  };
}

/**
 * Every figure in the generated copy that the article itself never mentions.
 *
 * Numbers are the part of a hallucination that does concrete damage here. A
 * loose adjective in a meta description is a style problem; "closing costs are
 * 1.5% of the purchase price" in an AI Overview, when the article never said
 * so, is the firm publishing a number it did not stand behind.
 *
 * Deliberately narrow: only numeric tokens, and matched as digit sequences so
 * that "$1,500" in the copy is satisfied by "1,500" or "1500" in the article.
 * Prose claims are not checked — that would need a model to check the model,
 * and the admin is reviewing this screen anyway. This catches the specific
 * failure that a reviewer skimming for tone is most likely to read straight
 * past.
 */
export function verifyGrounding(
  articleText: string,
  generated: BlogSeoFields,
): string[] {
  const digitsIn = (s: string) =>
    (s.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,\s]/g, "").replace(/\.$/, ""));

  const sourceNumbers = new Set(digitsIn(articleText));
  // Ordinals and small counts ("3 steps", "first") are almost always the
  // model's own phrasing rather than a claim, and flagging them would train
  // the reviewer to ignore this warning entirely.
  const ignorable = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

  const checked: { where: string; text: string }[] = [
    { where: "meta title", text: generated.metaTitle },
    { where: "meta description", text: generated.metaDescription },
    { where: "excerpt", text: generated.excerpt },
    ...generated.faq.map((f, i) => ({
      where: `FAQ answer ${i + 1}`,
      text: f.answer,
    })),
  ];

  const warnings: string[] = [];
  for (const { where, text } of checked) {
    const invented = [...new Set(digitsIn(text))].filter(
      (n) => !ignorable.has(n) && !sourceNumbers.has(n),
    );
    if (invented.length) {
      warnings.push(
        `The ${where} contains ${invented.length === 1 ? "a figure" : "figures"} the article never states: ${invented.join(", ")}. Remove it or check the source before publishing.`,
      );
    }
  }
  return warnings;
}

/** Trims at a word boundary rather than mid-word, and says so in a warning. */
function clamp(
  value: string,
  max: number,
  label: string,
  warnings: string[],
): string {
  if (value.length <= max) return value;

  const cut = value.slice(0, max);
  const atSpace = cut.lastIndexOf(" ");
  const trimmed = (atSpace > max * 0.6 ? cut.slice(0, atSpace) : cut).replace(/[\s,;:.–-]+$/, "");

  warnings.push(
    `The ${label} came back at ${value.length} characters (limit ${max}) and was trimmed. Reword it so it ends cleanly.`,
  );
  return trimmed;
}

export async function generateBlogSeo(input: {
  title: string;
  /** The formatted article HTML, or the author's raw text — either works. */
  body: string;
}): Promise<BlogSeoOutcome> {
  // Accepts HTML or plain text: blogHtmlToText leaves tag-free input alone, so
  // this works whether the admin has formatted the post yet or not.
  const articleText = blogHtmlToText(input.body).trim();

  if (articleText.length === 0) {
    return { ok: false, error: "Nothing to work from — write the article first." };
  }
  if (articleText.length < 200) {
    return {
      ok: false,
      error: "The article is too short to draft useful search metadata from. Write more of it first.",
    };
  }
  if (articleText.length > MAX_INPUT_CHARS) {
    return {
      ok: false,
      error: `Article is ${articleText.length.toLocaleString()} characters; the limit is ${MAX_INPUT_CHARS.toLocaleString()}. Split it into shorter posts.`,
    };
  }

  const result = await callGeminiJson({
    prompt: buildPrompt(input.title, articleText),
    parse: parseSeoJson,
    label: "blogSeo",
    maxOutputTokens: 2000,
  });

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "GEMINI_ALL_RUNGS_FAILED"
          ? "Could not draft the search metadata right now. Please try again in a moment."
          : result.error,
    };
  }

  const { warnings: modelWarnings, ...fields } = result.data;
  const warnings = [...modelWarnings];

  const clamped: BlogSeoFields = {
    ...fields,
    metaTitle: clamp(fields.metaTitle, META_TITLE_MAX, "meta title", warnings),
    metaDescription: clamp(
      fields.metaDescription,
      META_DESC_MAX,
      "meta description",
      warnings,
    ),
    excerpt: clamp(fields.excerpt, EXCERPT_MAX, "excerpt", warnings),
    tags: fields.tags.slice(0, 5),
    faq: fields.faq.slice(0, 5),
  };

  // Grounding warnings go first: they are the ones that must not be skimmed.
  warnings.unshift(...verifyGrounding(articleText, clamped));

  if (clamped.faq.length === 0) {
    warnings.push(
      "No FAQ was returned, so this post will not carry FAQPage structured data. Usually means the article did not clearly answer any question.",
    );
  }

  logger.info(
    `[blogSeo] model=${result.model} in=${articleText.length}ch faq=${clamped.faq.length} warnings=${warnings.length}`,
  );

  return { ok: true, data: { ...clamped, warnings, model: result.model } };
}
