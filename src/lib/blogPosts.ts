import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";
import { sanitizeBlogHtml, readingTimeFromHtml } from "./sanitizeBlogHtml";
import { slugify } from "./blogSlug";

export { slugify };

/**
 * Every admin-side read and write of the blog goes through here.
 *
 * `blog_posts` lives in the SAME Supabase database as everything else, and is
 * shared with the customer portal (iclosed_dev_web), which owns the reader
 * surfaces: the public /blogs pages and the client dashboard's Blog tab. This
 * app owns authoring — it is the CMS, and it is the only place a post is
 * written. The table was created by the portal's sql/create_blog_posts.sql;
 * apply that file first if these calls come back with 42P01.
 *
 * Everything runs on the service-role client, which is why the table has RLS
 * on with no policies and no anon grant. That also means the GRANT in that SQL
 * file is load-bearing: without it every statement here fails with 42501
 * "permission denied for table blog_posts" and surfaces as a generic 500.
 *
 * NOTE on going live: the portal's blog pages carry
 * `export const revalidate = 300`, a separate cache in a separate deployment.
 * This app's own write routes (create/update/delete/publish) call
 * revalidatePortalBlog() after a save that touches a live post, which asks
 * the portal to drop that cache immediately instead of waiting out the
 * 5-minute timer. That call is best-effort — if it fails or isn't configured,
 * the portal's own timer is still the fallback.
 */

export type BlogStatus = "draft" | "scheduled" | "published";
export type ContentSource = "manual" | "gemini" | "gemini_edited";

export type BlogFaqItem = { question: string; answer: string };

/** A row as it exists in the table. */
export type BlogPostRow = {
  id: string;
  created_at: string;
  updated_at: string;
  slug: string;
  status: BlogStatus;
  published_at: string | null;
  title: string;
  excerpt: string | null;
  content_html: string | null;
  content_source: string | null;
  reading_time_min: number | null;
  cover_image_url: string | null;
  cover_image_alt: string | null;
  author: string;
  tags: string[];
  meta_title: string | null;
  meta_description: string | null;
  canonical_url: string | null;
  og_image_url: string | null;
  focus_keyword: string | null;
  faq: BlogFaqItem[];
  noindex: boolean;
  seo_source: ContentSource;
  format_source: ContentSource;
  formatted_at: string | null;
  format_model: string | null;
  created_by_email: string | null;
  updated_by_email: string | null;
  import_batch_id: string | null;
};

const SELECT_COLS = `
  id, created_at, updated_at, slug, status, published_at,
  title, excerpt, content_html, content_source, reading_time_min,
  cover_image_url, cover_image_alt, author, tags,
  meta_title, meta_description, canonical_url, og_image_url, focus_keyword,
  faq, noindex, seo_source, format_source, formatted_at, format_model,
  created_by_email, updated_by_email, import_batch_id
`;

/**
 * Admin list — every status. Undated drafts first (newly imported, awaiting
 * publish), then by published date, newest first, so the list follows the same
 * order the portal shows. `updated_at` only breaks ties.
 */
export async function listAllPosts(): Promise<BlogPostRow[]> {
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select(SELECT_COLS)
    .order("published_at", { ascending: false, nullsFirst: true })
    .order("updated_at", { ascending: false });

  if (error) {
    logger.error("[blogPosts] listAllPosts failed:", error.message);
    return [];
  }
  return (data ?? []) as unknown as BlogPostRow[];
}

/**
 * Every post's title + slug, for the import preview's duplicate check. A
 * dedicated narrow select rather than reusing listAllPosts(): the import route
 * calls this on every upload and has no use for the other two dozen columns.
 */
export async function listTitlesAndSlugs(): Promise<{ id: string; title: string; slug: string }[]> {
  const { data, error } = await supabaseAdmin.from("blog_posts").select("id, title, slug");
  if (error) {
    logger.error("[blogPosts] listTitlesAndSlugs failed:", error.message);
    return [];
  }
  return (data ?? []) as { id: string; title: string; slug: string }[];
}

export async function getPostById(id: string): Promise<BlogPostRow | null> {
  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .select(SELECT_COLS)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    logger.error(`[blogPosts] getPostById(${id}) failed:`, error.message);
    return null;
  }
  return (data as unknown as BlogPostRow) ?? null;
}

/**
 * A slug not already taken, suffixing -2, -3 … on collision.
 *
 * Checked case-insensitively because the unique index is on lower(slug):
 * without the ilike this would happily hand back a slug that the insert then
 * rejects.
 */
export async function uniqueSlug(desired: string, excludeId?: string): Promise<string> {
  const base = slugify(desired) || "post";

  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    let q = supabaseAdmin.from("blog_posts").select("id").ilike("slug", candidate);
    if (excludeId) q = q.neq("id", excludeId);

    const { data } = await q.maybeSingle();
    if (!data) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export type BlogPostWrite = Partial<
  Omit<BlogPostRow, "id" | "created_at" | "updated_at">
>;

export type BlogWriteOutcome =
  | { ok: true; row: BlogPostRow }
  | { ok: false; error: string };

export async function createPost(
  fields: BlogPostWrite,
  adminEmail: string,
): Promise<BlogWriteOutcome> {
  const title = (fields.title ?? "").trim();
  if (!title) return { ok: false, error: "A title is required." };

  const slug = await uniqueSlug(fields.slug || title);
  const content_html = sanitizeBlogHtml(fields.content_html);

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .insert({
      ...fields,
      title,
      slug,
      content_html,
      reading_time_min: fields.reading_time_min ?? readingTimeFromHtml(content_html),
      status: fields.status ?? "draft",
      created_by_email: adminEmail,
      updated_by_email: adminEmail,
    })
    .select(SELECT_COLS)
    .single();

  if (error) {
    logger.error("[blogPosts] createPost failed:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, row: data as unknown as BlogPostRow };
}

export async function updatePost(
  id: string,
  fields: BlogPostWrite,
  adminEmail: string,
): Promise<BlogWriteOutcome> {
  const patch: Record<string, unknown> = {
    ...fields,
    updated_by_email: adminEmail,
    updated_at: new Date().toISOString(),
  };

  if (typeof fields.slug === "string" && fields.slug.trim()) {
    patch.slug = await uniqueSlug(fields.slug, id);
  }

  // Sanitized on the way in as well as on the way out. The portal sanitizes
  // again when it renders, but a clean stored copy is what makes the excerpt,
  // the reading time and any later diff trustworthy.
  if (typeof fields.content_html === "string") {
    const clean = sanitizeBlogHtml(fields.content_html);
    patch.content_html = clean;
    patch.reading_time_min = fields.reading_time_min ?? readingTimeFromHtml(clean);
  }

  const { data, error } = await supabaseAdmin
    .from("blog_posts")
    .update(patch)
    .eq("id", id)
    .select(SELECT_COLS)
    .single();

  if (error) {
    logger.error(`[blogPosts] updatePost(${id}) failed:`, error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, row: data as unknown as BlogPostRow };
}

export async function deletePost(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabaseAdmin.from("blog_posts").delete().eq("id", id);
  if (error) {
    logger.error(`[blogPosts] deletePost(${id}) failed:`, error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
