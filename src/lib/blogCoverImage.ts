import { put } from "@vercel/blob";
import { generateImagePrompt } from "./blogImagePrompt";
import { generateGeminiImage } from "./blogImageGen";
import { logger } from "./logger";

/**
 * Prompt → render → upload for one blog cover image, as a plain function.
 *
 * The same three steps POST /api/admin/blog/generate-image runs for the
 * editor's button, here for the background import worker (blogImportQueue.ts),
 * which has no request to hand to that route.
 */

export type CoverImageOutcome =
  | { ok: true; url: string; alt: string }
  | { ok: false; error: string };

export async function generateBlogCoverImage(input: {
  title: string;
  body: string;
}): Promise<CoverImageOutcome> {
  // Always the public store — a cover is shown to anonymous readers, whatever
  // NEXT_PUBLIC_PRIVATE_BLOB says about PII documents (same as the route).
  const token = process.env.BLOB_PUBLIC_READ_WRITE_TOKEN;
  if (!token) {
    return {
      ok: false,
      error: "BLOB_PUBLIC_READ_WRITE_TOKEN is not configured on the server, so a cover image cannot be uploaded.",
    };
  }

  const promptResult = await generateImagePrompt(input);
  if (!promptResult.ok) return { ok: false, error: promptResult.error };

  const { prompt, description } = promptResult.data;
  const image = await generateGeminiImage(`${prompt} 16:9 aspect ratio, professional blog cover image.`);
  if (!image.ok) return { ok: false, error: image.error };

  try {
    const ext = image.data.mimeType.split("/")[1] || "png";
    const blob = await put(`blog-cover-${Date.now()}.${ext}`, Buffer.from(image.data.base64, "base64"), {
      access: "public",
      token,
      contentType: image.data.mimeType,
      addRandomSuffix: true,
    });
    return { ok: true, url: blob.url, alt: description };
  } catch (err) {
    logger.error(
      `[blogCoverImage] upload failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ok: false, error: "The cover image was generated, but could not be uploaded." };
  }
}
