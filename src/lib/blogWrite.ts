import type {BlogPostWrite} from "./blogPosts";

/** Fields a client is allowed to set. Anything else in the body is ignored. */
const WRITABLE = [
  "slug", "status", "published_at",
  "title", "excerpt", "content_html", "content_source", "reading_time_min",
  "cover_image_url", "cover_image_alt", "author", "tags",
  "meta_title", "meta_description", "canonical_url", "og_image_url",
  "focus_keyword", "faq", "noindex", "seo_source", "format_source",
  "formatted_at", "format_model", "import_batch_id",
] as const;

export function pickWritable(input: Record<string, unknown>): BlogPostWrite {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    if (key in input && input[key] !== undefined) out[key] = input[key];
  }
  return out as BlogPostWrite;
}
