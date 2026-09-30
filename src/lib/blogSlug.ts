/**
 * URL-safe slug from a title.
 *
 * Its own module rather than living in blogPosts.ts, because that file imports
 * the service-role Supabase client, which throws at import time when the env
 * vars are absent. A pure string function should not need a database to be
 * called — or to be tested.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    // Strip combining marks, so "Ontario Café" folds to "ontario-cafe" rather
    // than dropping the accented letter entirely.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // Past ~70 characters a slug is truncated in search results and adds
    // nothing. Trim a trailing hyphen the cut may have left behind.
    .slice(0, 70)
    .replace(/-+$/g, "");
}
