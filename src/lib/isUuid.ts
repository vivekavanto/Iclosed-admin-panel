// SEC-013 — validate id values are RFC-4122 UUIDs before they are used in
// queries, especially any string-interpolated Supabase filter (.or(...)). This
// is defense-in-depth: route params and derived ids should already be UUIDs, but
// validating rejects anything malformed instead of splicing it into a filter.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}
