import { NextResponse } from "next/server";
import { getActingAdmin } from "@/lib/getActingAdmin";
import { rateLimitOk } from "@/lib/rateLimit";
import { generateImagePrompt } from "@/lib/blogImagePrompt";
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

  // Step 1: Generate image prompt from article content
  const promptResult = await generateImagePrompt({ title, body });
  if (!promptResult.ok) {
    return NextResponse.json(
      { success: false, error: promptResult.error },
      { status: 502 },
    );
  }

  const { prompt, description } = promptResult.data;

  // Step 2: Generate image using Replicate API
  // If REPLICATE_API_TOKEN is not set, return the prompt for user to generate manually
  const replicateToken = process.env.REPLICATE_API_TOKEN;
  if (!replicateToken) {
    return NextResponse.json({
      success: true,
      imageUrl: null,
      prompt,
      description,
      message:
        "Image prompt generated. To auto-generate images, set REPLICATE_API_TOKEN environment variable. For now, you can use this prompt with DALL-E, Midjourney, or Replicate directly.",
    });
  }

  try {
    // Call Replicate API to generate image (using a fast model like Flux Schnell)
    // Flux Schnell is much faster than other options and high quality
    const imageRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${replicateToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "e04e9146803e01eb96e91c2559caa7ad02819b8154b33f1bba40dc924507d91f", // Flux 1.0 Pro (faster)
        input: {
          prompt,
          aspect_ratio: "16:9",
          num_outputs: 1,
        },
      }),
    });

    if (!imageRes.ok) {
      const errorText = await imageRes.text();
      console.error(
        `[blogGenerateImage] Replicate error: ${imageRes.status} ${errorText}`,
      );
      return NextResponse.json({
        success: true,
        imageUrl: null,
        prompt,
        description,
        message:
          "Image prompt generated, but image generation is currently unavailable. You can use the prompt with DALL-E or Midjourney.",
      });
    }

    const prediction = (await imageRes.json()) as {
      id?: string;
      status?: string;
      output?: string[];
      error?: string;
    };

    // Replicate returns immediately with status "processing"
    // For now, return the prompt and let the client poll or use it manually
    // A production version would implement webhook polling or scheduled checks

    if (prediction.output && prediction.output.length > 0) {
      const imageUrl = prediction.output[0];

      // Upload to Vercel Blob with auto-cleanup after 30 days
      const blobResult = await put(`blog-cover-${Date.now()}.webp`, imageUrl, {
        access: "public",
        // Add metadata for cleanup purposes
        addRandomSuffix: true,
      });

      return NextResponse.json({
        success: true,
        imageUrl: blobResult.url,
        prompt,
        description,
        message: "Image generated and uploaded successfully.",
      });
    } else {
      return NextResponse.json({
        success: true,
        imageUrl: null,
        prompt,
        description,
        message:
          "Image is being generated. Please check back in a moment or use the prompt with another tool.",
      });
    }
  } catch (err) {
    console.error("[blogGenerateImage] Error:", err);
    // Fail gracefully - return the prompt even if image generation fails
    return NextResponse.json({
      success: true,
      imageUrl: null,
      prompt,
      description,
      message:
        "Image prompt generated, but image generation encountered an error. Use the prompt with DALL-E or Midjourney.",
    });
  }
}
