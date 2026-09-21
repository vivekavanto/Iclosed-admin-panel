import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import supabaseAdmin from "@/lib/supabaseAdmin";
import { logger } from "@/lib/logger";
import { isBlobUrl, blobTokenForUrl } from "@/lib/blobPrivacy";

/**
 * POST /api/admin/blog/cover — upload the image shown at the top of a post.
 *
 * multipart/form-data:
 *   file      the image
 *   replaces  optional — the cover URL this one is taking over from
 *
 * Returns { success, url }. Like the two AI routes it touches no blog_posts
 * row: the editor puts the URL in the Cover image field and the post is not
 * changed until the admin presses Save.
 *
 * ── Deliberately PUBLIC, ignoring NEXT_PUBLIC_PRIVATE_BLOB ──────────────
 * Same reasoning as the firm letterhead route
 * (api/admin/closing-cost-config/firms/[firmKey]/logo). That flag exists for
 * client documents — government IDs, agreements — where a leaked URL is a
 * privacy incident. A blog cover is the opposite: it is published on the
 * public website, hotlinked by whatever scrapes the og:image, and there is
 * nothing about it to protect.
 *
 * It is also the one place where getting this wrong is invisible until it is
 * live. The customer portal renders the cover straight from `cover_image_url`
 * with no session and no proxy, so a private blob URL would store fine, preview
 * fine here (an admin has a session), and appear on the public blog as a broken
 * image. Hence the hard-coded public token rather than blobToken() — and hence
 * the existing hint under the field.
 *
 * Gated to admins by src/middleware.ts.
 */

export const runtime = "nodejs";

/** Generous for a cover photograph, far below the 30 MB document ceiling. */
const MAX_COVER_BYTES = 8 * 1024 * 1024; // 8 MB

// Narrower than uploadValidation's document allowlist on purpose. HEIC is
// accepted there because that is what an iPhone hands over, but no browser
// renders it, so a HEIC cover is a broken image on the public site. PDF is
// obviously not a cover. SVG is excluded because it is a script-execution
// vector that no sanitizer here would ever see.
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/avif"]);
const ALLOWED_EXT = new Set(["png", "jpg", "jpeg", "webp", "avif"]);
const ALLOWED_LABEL = "PNG, JPG, WEBP or AVIF";

function validateCover(file: File): { ok: true } | { ok: false; error: string } {
  if (!file || typeof file.size !== "number") return { ok: false, error: "No file provided." };
  if (file.size === 0) return { ok: false, error: "That file is empty." };
  if (file.size > MAX_COVER_BYTES) {
    return {
      ok: false,
      error: `The cover image must be ${Math.floor(MAX_COVER_BYTES / 1024 / 1024)} MB or smaller.`,
    };
  }

  const mime = (file.type || "").toLowerCase();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  // Either signal is enough — browsers report image MIME types inconsistently.
  if (!ALLOWED_MIME.has(mime) && !ALLOWED_EXT.has(ext)) {
    return {
      ok: false,
      error: `The cover image must be a ${ALLOWED_LABEL} file. HEIC and SVG do not render on the public blog.`,
    };
  }
  return { ok: true };
}

/**
 * Removes the cover a post is moving off, once the new one is in hand.
 *
 * Refuses to delete anything a blog_posts row still points at. The editor holds
 * unsaved state, so `replaces` may name an image that is still the SAVED cover
 * of this post or, after a copy-paste, of a different one — deleting it would
 * blank a live article's header image, and the admin could still press Cancel.
 * Best-effort throughout: an orphaned blob is untidy, never a reason to fail an
 * upload that already succeeded.
 */
async function discardReplacedCover(url: unknown): Promise<void> {
  const previous = typeof url === "string" ? url.trim() : "";
  if (!previous || !isBlobUrl(previous)) return;

  try {
    // Two plain .eq queries rather than one .or(): PostgREST parses an .or()
    // filter as a comma-separated list, so a blob URL whose filename contains a
    // comma or a bracket would split into nonsense. That fails OPEN — the
    // malformed query matches nothing, the image looks unreferenced, and a live
    // post loses its header image. A stored filename is author-controlled, so
    // this is not a theoretical shape.
    for (const column of ["cover_image_url", "og_image_url"] as const) {
      const { data, error } = await supabaseAdmin
        .from("blog_posts")
        .select("id")
        .eq(column, previous)
        .limit(1);

      if (error) {
        logger.warn(
          "[blogCover] could not check for references, keeping the old image:",
          error.message,
        );
        return;
      }
      if (data && data.length > 0) return;
    }

    await del(previous, { token: blobTokenForUrl(previous) });
  } catch (err) {
    logger.warn("[blogCover] could not delete the replaced cover image:", err);
  }
}

export async function POST(req: Request) {
  let file: File | null = null;
  let replaces = "";
  try {
    const form = await req.formData();
    file = form.get("file") as File | null;
    const r = form.get("replaces");
    replaces = typeof r === "string" ? r : "";
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: `Could not read the upload. The image must be ${Math.floor(MAX_COVER_BYTES / 1024 / 1024)} MB or smaller.`,
      },
      { status: 400 },
    );
  }

  if (!file) {
    return NextResponse.json(
      { success: false, error: "Choose an image to upload." },
      { status: 400 },
    );
  }

  const check = validateCover(file);
  if (!check.ok) {
    return NextResponse.json({ success: false, error: check.error }, { status: 400 });
  }

  let url: string;
  try {
    const blob = await put(`blog-covers/${Date.now()}-${file.name}`, file, {
      access: "public",
      token: process.env.BLOB_PUBLIC_READ_WRITE_TOKEN,
    });
    url = blob.url;
  } catch (err) {
    logger.error("[blogCover] blob upload failed:", err);
    return NextResponse.json(
      { success: false, error: "Could not upload the image. Please try again." },
      { status: 502 },
    );
  }

  // Only once the new image is safely stored is the old one worth removing.
  await discardReplacedCover(replaces);

  return NextResponse.json({ success: true, url, fileName: file.name });
}
