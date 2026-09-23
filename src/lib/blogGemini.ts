import { logger } from "./logger.ts";

/**
 * One Gemini call, with the fallback ladder around it.
 *
 * MIRRORED from the customer portal (iclosed_dev_web/src/lib/geminiJson.ts),
 * renamed here because this app has other Gemini callers and nothing outside
 * the blog uses this ladder. The ladder is the part worth having in one place: a "503 model is
 * overloaded" has nothing to do with our request, so every caller wants the
 * same retry-on-a-smaller-rung behaviour, and a second hand-rolled copy of it
 * would drift the moment a model id changed.
 *
 * Raw fetch rather than the @google/genai SDK, matching
 * src/app/api/admin/identify-document/route.ts — the Gemini caller this app
 * already had.
 *
 * Verify an id exists before reordering the ladder:
 *   curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
 */

export type GeminiRung = { id: string; timeoutMs: number };

/**
 * Two rungs, not the three that extract-aps needs. That ladder exists because
 * a twelve-page scanned agreement could take 115 seconds to come back as a
 * 503. The blog's calls are a few thousand words of text in and text out, so
 * the budget is much smaller — but the fallback still matters.
 *
 * Reduced from 30s to 22s on first rung to speed up fallback to lite model if
 * the primary is slow. Metadata generation (SEO) is consistently faster than
 * markup (format), so budget is tighter there.
 */
export const BLOG_MODEL_LADDER: readonly GeminiRung[] = [
  { id: "gemini-3.5-flash", timeoutMs: 22_000 },
  { id: "gemini-3.1-flash-lite", timeoutMs: 18_000 },
] as const;

/**
 * The ladder for a call that carries a PDF rather than a few thousand
 * characters of text. Same two rungs, roughly double the patience: the bytes
 * have to be uploaded and every page read before a single token comes back, so
 * the 30s budget above would time out a perfectly healthy transcription of a
 * ten-page article.
 */
export const BLOG_FILE_LADDER: readonly GeminiRung[] = [
  { id: "gemini-3.5-flash", timeoutMs: 60_000 },
  { id: "gemini-3.1-flash-lite", timeoutMs: 40_000 },
] as const;

// NOTE: do not add generationConfig.thinkingConfig. The flash-lite tier answers
// `thinkingBudget: 0` with "400 Request contains an invalid argument", which
// would take out the fallback rung and leave nothing to fall back to.

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export function geminiApiKey(): string | null {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || null;
}

/** Strips the code fences a model sometimes adds despite responseMimeType. */
export function stripJsonFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export type GeminiJsonOutcome<T> =
  | { ok: true; data: T; model: string }
  | { ok: false; error: string };

/** A `contents[].parts[]` entry, in the REST API's snake_case spelling. */
export type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

type LadderOptions<T> = {
  parts: GeminiPart[];
  parse: (raw: string) => T;
  label: string;
  temperature?: number;
  responseMimeType?: string;
  maxOutputTokens?: number;
  ladder?: readonly GeminiRung[];
};

/**
 * Runs one request down the ladder until a rung returns text that `parse`
 * accepts, and returns whatever `parse` produced.
 *
 * `parse` throwing is treated exactly like a transport failure — the rung is
 * recorded as failed and the next one is tried. That is deliberate: a model
 * that answers with prose instead of the requested object has failed in the
 * same practical way as one that timed out, and the smaller rung may well get
 * it right.
 *
 * `label` only ever appears in server logs.
 */
async function runLadder<T>(opts: LadderOptions<T>): Promise<GeminiJsonOutcome<T>> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    logger.error(`[${opts.label}] GEMINI_API_KEY is not set in process.env`);
    return { ok: false, error: "GEMINI_API_KEY is not configured on the server." };
  }

  const requestBody = {
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: {
      // Zero by default, not the warmer setting a copywriting task would want.
      // The same input should produce the same output twice, so that re-running
      // one of these is a no-op rather than a reshuffle.
      temperature: opts.temperature ?? 0,
      ...(opts.responseMimeType ? { responseMimeType: opts.responseMimeType } : {}),
      ...(opts.maxOutputTokens ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    },
  };

  const failures: string[] = [];

  for (const rung of opts.ladder ?? BLOG_MODEL_LADDER) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), rung.timeoutMs);

    try {
      const res = await fetch(`${endpointFor(rung.id)}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        failures.push(`${rung.id}: HTTP ${res.status} ${detail.slice(0, 160)}`);
        continue;
      }

      const json = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      // Long answers come back split across several parts, not one. Joining
      // them matters for the PDF transcription, where taking parts[0] alone
      // would silently truncate the article at whatever boundary the model chose.
      const text = (json.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text ?? "")
        .join("");
      if (!text) {
        failures.push(`${rung.id}: empty response`);
        continue;
      }

      return { ok: true, data: opts.parse(text), model: rung.id };
    } catch (err: unknown) {
      const reason =
        err instanceof Error && err.name === "AbortError"
          ? `timed out after ${rung.timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : "unknown error";
      failures.push(`${rung.id}: ${reason}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  logger.error(`[${opts.label}] every model failed — ${failures.join(" | ")}`);
  return { ok: false, error: "GEMINI_ALL_RUNGS_FAILED" };
}

/** A JSON call: `prompt` in, `parse` applied to the de-fenced response. */
export async function callGeminiJson<T>(opts: {
  prompt: string;
  parse: (raw: string) => T;
  label: string;
  /** Zero unless a caller genuinely wants variation. */
  temperature?: number;
  ladder?: readonly GeminiRung[];
}): Promise<GeminiJsonOutcome<T>> {
  return runLadder({
    parts: [{ text: opts.prompt }],
    // De-fenced here rather than in runLadder: a plain-text answer may
    // legitimately contain a fenced block, and stripping it would corrupt a
    // transcription.
    parse: (raw) => opts.parse(stripJsonFences(raw)),
    label: opts.label,
    temperature: opts.temperature,
    responseMimeType: "application/json",
    ladder: opts.ladder,
  });
}

/**
 * A plain-text call, which may carry a file alongside the prompt.
 *
 * Used by the PDF branch of the blog importer, where the answer is the whole
 * article and wrapping tens of thousands of characters in a JSON string only
 * adds a way for the response to arrive unparseable.
 */
export async function callGeminiText(opts: {
  parts: GeminiPart[];
  label: string;
  temperature?: number;
  maxOutputTokens?: number;
  ladder?: readonly GeminiRung[];
}): Promise<GeminiJsonOutcome<string>> {
  return runLadder({
    ...opts,
    parse: (raw) => {
      const text = raw.trim();
      if (!text) throw new Error("Model returned no text.");
      return text;
    },
  });
}
