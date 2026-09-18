import supabaseAdmin from "./supabaseAdmin";
import { normalizeEmailKey, sameEmail } from "./emailKey";

/**
 * Whitespace-tolerant lookup of `leads` / `clients` rows by email.
 *
 * WHY THIS EXISTS: the portal's intake used to store the email EXACTLY as the
 * client typed it, while Supabase Auth trims the address it registers. A client
 * who pasted "someone@example.com " therefore ends up with a lead/client row
 * whose email carries a trailing space and an auth identity that does not — and
 * every `.eq("email", …)` / wildcard-free `.ilike("email", …)` lookup silently
 * misses the row.
 *
 * That miss is not cosmetic: it is what broke the "your client just signed up"
 * agent notification. activateClientDeals() resolved neither client nor lead, so
 * the deal was never promoted off "Inactive", and sendAgentSignupEmail()'s
 * activation gate then skipped the send forever — reporting success the whole
 * way, so nothing appeared in the logs.
 *
 * The intake now trims on write and a migration trimmed the existing rows, but
 * these helpers stay: they cost one wildcard scan and make the whole chain
 * immune to the next row that slips through (a manual edit, an import, a
 * non-breaking space pasted out of a PDF).
 */

export { normalizeEmailKey, sameEmail } from "./emailKey";

/**
 * Rows in `table` whose email matches `email` ignoring surrounding whitespace.
 *
 * Postgres cannot be asked to `btrim()` a column inside a PostgREST filter, so
 * this casts a deliberately wide net — `%address%` — and settles it in JS with
 * `sameEmail`. The pattern is NOT escaped: an `_` in a local part is a LIKE
 * wildcard and will pull in extra candidates, which is harmless precisely
 * because the exact comparison happens afterwards.
 *
 * Ordered newest-first so callers that want a single row get the same one the
 * old `.order("created_at").limit(1)` lookups returned.
 */
export async function findRowsByEmail<T extends object>(
  table: "leads" | "clients",
  columns: string,
  email: string | null | undefined,
  opts: { limit?: number } = {},
): Promise<Array<T & { email?: string | null }>> {
  const wanted = normalizeEmailKey(email);
  if (!wanted) return [];

  const select = columns.includes("email") ? columns : `${columns}, email`;
  const { data, error } = await supabaseAdmin
    .from(table)
    .select(select)
    .ilike("email", `%${wanted}%`)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 50);

  if (error) return [];
  const matches = ((data ?? []) as unknown as Array<T & { email?: string | null }>).filter(
    (row) => sameEmail(row.email, wanted),
  );

  // Already-clean rows rank first, newest-within-rank preserved.
  //
  // Widening the match can surface TWO rows where the old exact lookup could
  // only ever see one — a person with both "a@b.ca" and "a@b.ca " on file is a
  // duplicate record, and the stray space is usually how the duplicate came
  // about. Whichever row an existing login already resolved to must keep
  // winning, or this fix would quietly move someone onto their other record.
  // An exact `.eq()` could only ever have found the clean one, so that is the
  // one that stays in front; the loose match is a fallback, not a promotion.
  const clean = (row: { email?: string | null }) =>
    typeof row.email === "string" && row.email === row.email.trim();
  return [...matches.filter(clean), ...matches.filter((r) => !clean(r))];
}

/** The newest row in `table` matching `email`, or null. */
export async function findRowByEmail<T extends object>(
  table: "leads" | "clients",
  columns: string,
  email: string | null | undefined,
): Promise<(T & { email?: string | null }) | null> {
  const rows = await findRowsByEmail<T>(table, columns, email, { limit: 10 });
  return rows[0] ?? null;
}
