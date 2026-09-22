/**
 * Working out who wrote an article from the article itself.
 *
 * The posts arrive with the author stated in the prose — a byline under the
 * title ("By Kubeskaran Navaratnam, Managing Partner and Real Estate Lawyer,
 * iClosed · …") and usually an "About the author" section at the foot. The
 * Author field, meanwhile, keeps whatever the editor was opened with, which
 * for a new post is the house default. So the page credits the Law Desk while
 * the body it sits above credits a named lawyer, and the two disagree on
 * screen and in the Article structured data.
 *
 * This reads the name back out of the body so the field can be filled from
 * what the article actually says. It only ever SUGGESTS: nothing here writes
 * to the post on its own except on import, where there is no prior value to
 * overwrite.
 *
 * Pure string work, no DOM, so the editor (browser) and the import route
 * (server) can both call it.
 */

/** Text of the article, block by block, in document order. */
function htmlToLines(html: string): string[] {
  return html
    // Block boundaries become line breaks; inline tags just disappear, so
    // "By <a>Kubeskaran Navaratnam</a>, Managing Partner" stays one line.
    .replace(/<\/(p|h[1-6]|li|div|blockquote|tr|figcaption)\s*>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Where a name ends and the job title begins.
 *
 * A byline is one sentence — "By X, Managing Partner and Real Estate Lawyer,
 * iClosed · Licensed by the LSO · Last reviewed: September 2026" — and only
 * the part before the first separator is the person.
 */
const NAME_TAIL = /\s*(?:[,·|(–—]|\s[-–—]\s|\.\s|$)/;

// Lowercase words that are legitimately part of a name and must not
// disqualify it. Without these, "Ali van der Meer" is rejected.
const PARTICLES = new Set([
  "van", "von", "der", "den", "de", "del", "della", "di", "da", "dos",
  "du", "la", "le", "bin", "binti", "al", "el", "ibn", "san", "st",
]);

/**
 * Whether a string reads as a person's name.
 *
 * Deliberately strict. A false positive here silently republishes an article
 * under the wrong byline, which is worse than the admin typing the name in;
 * a false negative just means the suggestion does not appear.
 */
export function looksLikePersonName(value: string): boolean {
  const name = value.trim();
  if (name.length < 4 || name.length > 60) return false;
  if (/\d/.test(name)) return false;
  // "By the team at iClosed", "Our Real Estate Law Desk" — a description, not
  // a person, and the field already holds a better version of it.
  if (/\b(team|desk|group|llp|inc|firm|editor(?:ial)?|staff)\b/i.test(name)) return false;

  const words = name.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  if (!/^[A-Z]/.test(words[0])) return false;

  return words.every((word) => {
    if (PARTICLES.has(word.toLowerCase().replace(/\.$/, ""))) return true;
    // "Kubeskaran", "O'Brien", "Smith-Jones", "J." — a capital, then letters
    // and the punctuation names actually contain.
    return /^[A-Z][A-Za-z'’.-]*$/.test(word);
  });
}

/** The name at the start of `text`, if what follows it looks like a byline. */
function nameAtStart(text: string): string | null {
  const end = text.search(NAME_TAIL);
  const candidate = (end === -1 ? text : text.slice(0, end)).trim();
  if (looksLikePersonName(candidate)) return candidate;

  // No separator to cut at — the name opens a sentence rather than a byline
  // ("Aliya Shaikha is a real estate lawyer in Toronto."). Take the longest
  // run of words from the start that still reads as a name, longest first so
  // a three-part name is not truncated to two.
  const words = candidate.split(/\s+/);
  for (let n = Math.min(5, words.length); n >= 2; n--) {
    const prefix = words.slice(0, n).join(" ");
    if (looksLikePersonName(prefix)) return prefix;
  }
  return null;
}

/**
 * The punctuation that can stand between a marker and the name.
 *
 * Built as a string rather than written inline as a character class, in every
 * regex below — and the class it replaces is not written out anywhere in this
 * file, including in this comment.
 *
 * Tailwind's class scanner reads every source file in the project as plain
 * text, and a square-bracketed run containing a colon is exactly its
 * arbitrary-property syntax. A character class matching a dash or a colon is
 * that shape, so it was lifted out of an earlier version of this file, turned
 * into a rule whose declaration was a bare dash, and written into globals.css
 * — where the CSS parser rejected it and failed the whole build.
 */
const SEP = "(?:[-–—]|:)";

/**
 * Each way an article states its author, most explicit first.
 *
 * Order is the whole design. "About the author — Name" is a statement of
 * authorship and nothing else; a leading "By …" is nearly as good; "Reviewed
 * by" is last because a reviewer is often NOT the author, and is only used
 * when the article offers nothing better.
 */
const MARKERS: { re: RegExp; label: string }[] = [
  // The separator and the name are both optional: the heading is as often
  // "About the author" on its own, with the name in the paragraph below.
  {
    re: new RegExp(`^about\\s+the\\s+authors?\\s*${SEP}?\\s*(.*)$`, "i"),
    label: "About the author",
  },
  {
    re: new RegExp(`^(?:written|authored)\\s+by\\s*${SEP}?\\s*(.+)$`, "i"),
    label: "Written by",
  },
  { re: new RegExp(`^author\\s*${SEP}\\s*(.+)$`, "i"), label: "Author" },
  { re: /^by\s+(.+)$/i, label: "Byline" },
  {
    re: new RegExp(`^reviewed\\s+by\\s*${SEP}?\\s*(.+)$`, "i"),
    label: "Reviewed by",
  },
];

export type DetectedAuthor = {
  name: string;
  /** Which form it was read from — shown to the admin so they can judge it. */
  source: string;
};

/**
 * The author an article names, or null if it names none confidently.
 *
 * Scans the whole body rather than only the opening lines: an "About the
 * author" section sits at the foot, and that is the most reliable statement
 * of all. The marker that wins is the most explicit one found anywhere, not
 * the first one encountered.
 *
 * A bare "About the author" heading with the name in the paragraph beneath it
 * is handled too — the line after the heading is read as the candidate.
 */
export function detectAuthorFromHtml(html: string | null | undefined): DetectedAuthor | null {
  if (!html || !html.trim()) return null;

  const lines = htmlToLines(html);
  const found = new Map<string, string>();

  lines.forEach((line, index) => {
    for (const { re, label } of MARKERS) {
      const match = line.match(re);
      if (!match) continue;

      const name =
        nameAtStart(match[1]) ??
        // "About the author" alone on its line: the name is below it, either
        // as a bare name or as another byline.
        (match[1].trim() === "" && lines[index + 1]
          ? nameAtStart(lines[index + 1].replace(/^by\s+/i, ""))
          : null);

      if (name && !found.has(label)) found.set(label, name);
      break; // One marker per line; the list is ordered by specificity.
    }
  });

  for (const { label } of MARKERS) {
    const name = found.get(label);
    if (name) return { name, source: label };
  }
  return null;
}
