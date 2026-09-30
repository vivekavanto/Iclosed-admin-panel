import { blogHtmlToText } from "./sanitizeBlogHtml";
import { callGeminiJson } from "./blogGemini";
import { logger } from "./logger";

/**
 * Generates an image generation prompt from blog article content using Gemini.
 *
 * The prompt is designed for AI image generators (Replicate, DALL-E, etc.) and
 * aims to create a professional, on-brand image that complements the article's
 * topic without being too literal or cliché.
 */

export type ImagePromptResult = {
  prompt: string;
  description: string;
  model: string;
};

export type ImagePromptOutcome =
  | { ok: true; data: ImagePromptResult }
  | { ok: false; error: string };

function buildPrompt(title: string, articleText: string): string {
  return `You are a professional designer creating image prompts for a law firm's blog.

Based on the article below, generate a detailed, professional image prompt that would work well as a cover image. The image should:
- Be professional and trustworthy (not cartoonish or overly playful)
- Visually represent the article's topic without being too literal
- Appeal to Ontario homebuyers/sellers
- Work as a 16:9 aspect ratio blog cover image
- Include subtle legal/real-estate themes when appropriate

REQUIREMENTS:
- Output ONLY valid JSON, no other text
- Use sophisticated visual language, not clichés
- Avoid photographs of people's faces
- Keep it simple and elegant
- Include specific details that make a good image prompt

Article title: "${title}"

--- ARTICLE TEXT BEGINS ---
${articleText}
--- ARTICLE TEXT ENDS ---

Return JSON of exactly this shape:
{
  "prompt": "detailed prompt for image generation (200-300 characters)",
  "description": "brief one-liner describing what the image shows"
}`;
}

function parseImagePromptJson(text: string): { prompt: string; description: string } {
  const parsed = JSON.parse(text) as { prompt?: unknown; description?: unknown };

  if (typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
    throw new Error("Model returned no prompt field.");
  }

  if (typeof parsed.description !== "string" || !parsed.description.trim()) {
    throw new Error("Model returned no description field.");
  }

  return {
    prompt: parsed.prompt.trim(),
    description: parsed.description.trim(),
  };
}

export async function generateImagePrompt(input: {
  title: string;
  body: string;
}): Promise<ImagePromptOutcome> {
  const title = input.title?.trim() ?? "";
  const articleText = blogHtmlToText(input.body).trim();

  if (!title || articleText.length === 0) {
    return {
      ok: false,
      error: "Article title and content are required to generate an image prompt.",
    };
  }

  if (articleText.length < 200) {
    return {
      ok: false,
      error: "The article is too short. Write more content first.",
    };
  }

  const result = await callGeminiJson({
    prompt: buildPrompt(title, articleText),
    parse: parseImagePromptJson,
    label: "blogImagePrompt",
    maxOutputTokens: 1000,
  });

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "GEMINI_ALL_RUNGS_FAILED"
          ? "Could not generate an image prompt right now. Please try again in a moment."
          : result.error,
    };
  }

  logger.info(
    `[blogImagePrompt] model=${result.model} title=${title.slice(0, 50)}`,
  );

  return {
    ok: true,
    data: {
      ...result.data,
      model: result.model,
    },
  };
}
