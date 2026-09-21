import { logger } from "./logger";

/**
 * One Gemini JSON call, with the fallback ladder around it.
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
 */
export const BLOG_MODEL_LADDER: readonly GeminiRung[] = [
  { id: "gemini-3.5-flash", timeoutMs: 30_000 },
  { id: "gemini-3.1-flash-lite", timeoutMs: 20_000 },
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

/** Strips the ```json fences a model sometimes adds despite responseMimeType. */
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

/**
 * Runs `prompt` down the ladder until one rung returns JSON that `parse`
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
export async function callGeminiJson<T>(opts: {
  prompt: string;
  parse: (raw: string) => T;
  label: string;
  /** Zero unless a caller genuinely wants variation. */
  temperature?: number;
  ladder?: readonly GeminiRung[];
}): Promise<GeminiJsonOutcome<T>> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    logger.error(`[${opts.label}] GEMINI_API_KEY is not set in process.env`);
    return { ok: false, error: "GEMINI_API_KEY is not configured on the server." };
  }

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    generationConfig: {
      // Zero by default, not the warmer setting a copywriting task would want.
      // The same input should produce the same output twice, so that re-running
      // one of these is a no-op rather than a reshuffle.
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json",
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
      const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        failures.push(`${rung.id}: empty response`);
        continue;
      }

      return { ok: true, data: opts.parse(stripJsonFences(text)), model: rung.id };
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
