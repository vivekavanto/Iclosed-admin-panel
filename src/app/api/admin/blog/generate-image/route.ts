import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { generateImagePrompt } from "@/lib/blogImagePrompt";
import { generateGeminiImage } from "@/lib/blogImageGen";
import { put } from "@vercel/blob";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/admin/blog/generate-image
 *
 * Generates an image prompt from blog content using Gemini, then generates
 * an actual image and uploads it to Vercel Blob.
 *
 * Returns the public blob URL ready to use as a cover image.
 */

export async function POST(req: Request) {
  const { email } = await getActingAdmin();

  // Rate limit: image generation is expensive, so stricter than text formatting
  const allowed = await rateLimitOk(`blog-image:${email ?? "unknown"}`, 20, 60);
  if (!allowed) {
    return NextResponse.json(
      {
        success: false,
        error: "Too many image generation requests. Wait a few minutes and try again.",
      },
      { status: 429 },
    );
  }

  let payload: { title?: unknown; body?: unknown };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const title = typeof payload.title === "string" ? payload.title : "";
  const body = typeof payload.body === "string" ? payload.body : "";

  if (!title.trim() || !body.trim()) {
    return NextResponse.json(
      { success: false, error: "Article title and content are required." },
      { status: 400 },
    );
  }

  // Fail fast, before spending a Gemini call: without this token the upload
  // at the bottom of this route is guaranteed to fail (see the comment on the
  // put() call below for why it can't fall back to the private store's
  // token). Catching it here turns a generic "could not be uploaded" into a
  // message that actually says what to fix.
  if (!process.env.BLOB_PUBLIC_READ_WRITE_TOKEN) {
    return NextResponse.json(
      {
        success: false,
        error:
          "BLOB_PUBLIC_READ_WRITE_TOKEN is not configured on the server, so a cover image cannot be uploaded. Add it to the environment (same token blog/cover/route.ts's manual upload needs) and restart the app.",
      },
      { status: 500 },
    );
  }

  // Step 1: Generate image prompt from article content
  const promptResult = await generateImagePrompt({ title, body });
  if (!promptResult.ok) {
    return NextResponse.json(
      { success: false, error: promptResult.error },
      { status: 502 },
    );
  }

  const { prompt, description } = promptResult.data;

  // Step 2: Render the image itself with the same Gemini account used for the
  // prompt above — one provider for the whole blog pipeline, no separate
  // Replicate/DALL-E token to provision or fall back to.
  const imageResult = await generateGeminiImage(
    `${prompt} 16:9 aspect ratio, professional blog cover image.`,
  );

  if (!imageResult.ok) {
    return NextResponse.json({
      success: true,
      imageUrl: null,
      prompt,
      description,
      message: `Image prompt generated, but the image itself could not be rendered: ${imageResult.error}`,
    });
  }

  try {
    const ext = imageResult.data.mimeType.split("/")[1] || "png";
    const blobResult = await put(
      `blog-cover-${Date.now()}.${ext}`,
      Buffer.from(imageResult.data.base64, "base64"),
      {
        // Always the public store, not blobToken()/BLOB_ACCESS from blobPrivacy
        // (SEC-003): a blog cover image is rendered on the public site for
        // anonymous visitors, so it must stay public regardless of the
        // NEXT_PUBLIC_PRIVATE_BLOB flag that only governs PII documents. Same
        // pattern as blog/cover/route.ts, the manual-upload counterpart.
        access: "public",
        token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
        contentType: imageResult.data.mimeType,
        addRandomSuffix: true,
      },
    );

    return NextResponse.json({
      success: true,
      imageUrl: blobResult.url,
      prompt,
      description,
      message: "Image generated and uploaded successfully.",
    });
  } catch (err) {
    console.error("[blogGenerateImage] Blob upload error:", err);
    return NextResponse.json({
      success: true,
      imageUrl: null,
      prompt,
      description,
      message: "Image was generated, but could not be uploaded. Try again in a moment.",
    });
  }
}
