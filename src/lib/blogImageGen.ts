import { geminiApiKey } from "./blogGemini";
import { logger } from "./logger";

/**
 * Renders a blog cover image from a text prompt, using Gemini's image model.
 *
 * Separate from blogGemini.ts's JSON/text ladder: this call asks for an image
 * response (`responseModalities: ["IMAGE"]`) rather than text, so it does not
 * fit the shared runLadder() shape.
 *
 * Two rungs, same instinct as BLOG_MODEL_LADDER in blogGemini.ts: a transient
 * 5xx/429 from the primary image model has nothing to do with this specific
 * request, so a genuinely independent second model is worth trying before
 * telling the admin the cover image failed. Re-verify both ids exist before
 * reordering:
 *   curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
 */
const IMAGE_MODEL_LADDER: readonly { id: string; timeoutMs: number }[] = [
  { id: "gemini-2.5-flash-image", timeoutMs: 55_000 },
  { id: "gemini-3.1-flash-image", timeoutMs: 55_000 },
] as const;

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export type GeneratedImage = { base64: string; mimeType: string; model: string };

export type ImageGenOutcome =
  | { ok: true; data: GeneratedImage }
  | { ok: false; error: string };

export async function generateGeminiImage(prompt: string): Promise<ImageGenOutcome> {
  const apiKey = geminiApiKey();
  if (!apiKey) {
    logger.error("[blogImageGen] GEMINI_API_KEY is not set in process.env");
    return { ok: false, error: "GEMINI_API_KEY is not configured on the server." };
  }

  const failures: string[] = [];

  for (const rung of IMAGE_MODEL_LADDER) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), rung.timeoutMs);

    try {
      const res = await fetch(`${endpointFor(rung.id)}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"] },
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        failures.push(`${rung.id}: HTTP ${res.status} ${detail.slice(0, 200)}`);
        continue;
      }

      const json = (await res.json()) as {
        candidates?: {
          content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] };
        }[];
      };

      const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (!part?.inlineData?.data) {
        failures.push(`${rung.id}: no image in response`);
        continue;
      }

      return {
        ok: true,
        data: {
          base64: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "image/png",
          model: rung.id,
        },
      };
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

  logger.error(`[blogImageGen] every model failed — ${failures.join(" | ")}`);
  return { ok: false, error: "Could not render an image right now. Please try again in a moment." };
}
