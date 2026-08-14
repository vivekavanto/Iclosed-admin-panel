// The login-free closing-cost calculator at /closing-cost-calculator.
//
// ── What it is ──────────────────────────────────────────────────────────────
// The firm's quoting tool, served without a session so an admin can hand the
// link to clerks who have no portal account. It is not a cut-down copy: it is
// the one calculator this app has, and staff open the same URL from the sidebar.
// There is therefore ONE API pair (/api/calculator/*) rather than a gated twin,
// so a change to the quote a clerk sees cannot miss the page staff use.
//
// ── What that means, stated plainly ─────────────────────────────────────────
// A URL is not an authentication. Anyone who holds this link — a forwarded
// email, a browser history on a shared machine, a screenshot — has the firm's
// quoting tool, and can print a statement on the firm's letterhead showing
// whatever figures they type, including an unwatermarked "final account".
// Nothing is written to the database and no client is notified, so the exposure
// is the DOCUMENT, not the data.
//
// Two things narrow it, and they are the reason this file exists:
//
//   1. `publicConfigView` — the config is served through an allow-list, so a
//      column added to the config table tomorrow is not published to the world
//      by accident. The calculator gets fees and letterhead; nothing else.
//   2. The PDF route rate-limits by IP and FAILS CLOSED (see its own comment).
//
// If the link ever needs to stop being world-open, the smallest change that
// keeps it shareable is a shared passcode: one secret in Vercel env, checked in
// these two routes and held in sessionStorage by the page. No accounts, no
// login screen — just a word the clerks are told.

import { isPrivateBlobUrl } from "./blobPrivacy";
import {
  FIRM_FEE_COLUMNS,
  LETTERHEAD_COLUMNS,
  SHARED_RATE_COLUMNS,
} from "./closingCostSettings";

/**
 * Every config key the shared calculator is served: rates, because it computes
 * the statement in the browser on each keystroke, and letterhead, because it
 * draws the firm's heading above it. Row ids, audit columns and anything added
 * to the table later stay behind.
 */
const PUBLIC_CONFIG_KEYS: readonly string[] = [
  ...SHARED_RATE_COLUMNS,
  ...FIRM_FEE_COLUMNS,
  ...LETTERHEAD_COLUMNS,
  "firm_key",
  "label",
  "firm_badge",
  "brand_color",
  "logo_url",
];

/**
 * A config or firm row, reduced to the keys above.
 *
 * `logo_url` is dropped when it points at a PRIVATE blob: those are served
 * through /api/admin/documents/download, which requires an admin session, so on
 * this page the image would fail to load and the letterhead would show a broken
 * graphic. Letterhead falls back to the firm name, which is correct.
 */
export function publicConfigView(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (row[key] !== undefined) out[key] = row[key];
  }
  if (isPrivateBlobUrl(out.logo_url as string | null | undefined)) {
    delete out.logo_url;
  }
  return out;
}
