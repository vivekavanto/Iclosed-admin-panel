// The "magic link" the final reporting package is delivered with.
//
// ── Why a link and not an attachment ────────────────────────────────────
// A reporting package is a scanned bundle: 15-25 MB is normal, and MIME base64
// encoding inflates that by ~37% on the wire. Gmail refuses a message over
// 25 MB and Outlook over 20 MB, so attaching a real package produced either a
// hard bounce or a silently dropped email — and the 10 MB upload cap that
// avoided the problem meant staff could not file the package at all. The email
// now carries a tokenised download link, so the package size and the email size
// are unrelated. See MAX_FINAL_REPORT_BYTES in uploadValidation.ts.
//
// ── The token ───────────────────────────────────────────────────────────
// One row in `invitation_tokens` (type 'final_report'), the same store the
// invite / reset / retainer links use, carrying its scope in user_data:
//
//   { kind: 'final_report', deal_id, lead_ids: "id,id", doc_ids: "id,id" }
//
// The token grants exactly one thing — downloading THOSE document rows — and
// nothing else. It deliberately does NOT go through consumeInvitationToken():
//
//   • no consumption cap. That helper refuses a token after 10 uses, which is
//     right for a one-shot auth link and wrong here — a client re-opens their
//     reporting package months later, after several mail scanners have already
//     spent uses on it.
//   • no auth session. /api/auth/activate mints a Supabase recovery session for
//     the token's email; a download link is forwarded around far more freely
//     than an auth link, so it must never be spendable there. That route now
//     refuses any type other than invite/recovery.

import supabaseAdmin from "./supabaseAdmin";
import { createInvitationToken } from "./invitationToken";
import { logger } from "./logger";

/** `invitation_tokens.type` for a package download link. */
export const FINAL_REPORT_TOKEN_TYPE = "final_report";

/** The public route that serves the link. Outside /api/admin, so unauthenticated. */
export const FINAL_REPORT_DOWNLOAD_PATH = "/api/final-report/download";

/**
 * How long the link keeps working.
 *
 * 180 days, not the 7 of an auth link: this is a document a client comes back
 * to (their accountant asks for it in March), and an expired link means a phone
 * call to staff. It is not forever either — the permanent copy lives in the
 * client's portal Documents page behind a real login, which is what the email
 * points at once the link lapses.
 */
export const FINAL_REPORT_LINK_TTL_DAYS = 180;

export interface FinalReportTokenScope {
  email: string;
  dealId: string;
  leadIds: string[];
  docIds: string[];
}

export type FinalReportTokenResult =
  | { ok: true; scope: FinalReportTokenScope }
  | { ok: false; reason: "missing" | "expired" | "error" };

function splitIds(raw: unknown): string[] {
  return typeof raw === "string"
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
}

/**
 * Mint a download link for one group of recipients.
 *
 * Scoped to the documents that group is entitled to — on a Purchase & Sale file
 * the purchase side and the sale side are owed different packages, so they get
 * different links, and neither token can reach the other side's documents.
 */
export async function createFinalReportDownloadLink(opts: {
  /** Anchor recipient, recorded on the token row for audit. */
  email: string;
  dealId: string;
  leadIds: string[];
  docIds: string[];
}): Promise<{ token: string; url: string }> {
  const { token, url } = await createInvitationToken({
    type: FINAL_REPORT_TOKEN_TYPE,
    email: opts.email,
    // Where the token resolves to; kept for parity with the other token types,
    // which use it as a redirect target.
    redirectTo: FINAL_REPORT_DOWNLOAD_PATH,
    userData: {
      kind: FINAL_REPORT_TOKEN_TYPE,
      deal_id: opts.dealId,
      lead_ids: opts.leadIds.join(","),
      doc_ids: opts.docIds.join(","),
    },
    activatePath: FINAL_REPORT_DOWNLOAD_PATH,
    ttlDays: FINAL_REPORT_LINK_TTL_DAYS,
  });

  return { token, url };
}

/**
 * Validate a download token and return what it may open.
 *
 * Read-only on the way in; the use is stamped afterwards (best effort) so staff
 * can see on the token row whether the client ever opened their package.
 */
export async function verifyFinalReportToken(
  token: string,
): Promise<FinalReportTokenResult> {
  if (!token) return { ok: false, reason: "missing" };

  const { data, error } = await supabaseAdmin
    .from("invitation_tokens")
    .select("type, email, user_data, expires_at, consumption_count")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    logger.error("[FinalReportLink] token read failed:", error.message);
    return { ok: false, reason: "error" };
  }
  // A token of any OTHER type must not open documents, the same way a download
  // token must not mint an auth session.
  if (!data || data.type !== FINAL_REPORT_TOKEN_TYPE) {
    return { ok: false, reason: "missing" };
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const userData = (data.user_data ?? {}) as Record<string, unknown>;
  const docIds = splitIds(userData.doc_ids);
  if (docIds.length === 0) return { ok: false, reason: "missing" };

  // Best effort, never blocking: count the open and stamp the first one.
  const count = data.consumption_count ?? 0;
  const update: { consumption_count: number; used_at?: string } = {
    consumption_count: count + 1,
  };
  if (count === 0) update.used_at = new Date().toISOString();
  void supabaseAdmin
    .from("invitation_tokens")
    .update(update)
    .eq("token", token)
    .then(({ error: stampErr }) => {
      if (stampErr) {
        logger.warn("[FinalReportLink] could not stamp the open:", stampErr.message);
      }
    });

  return {
    ok: true,
    scope: {
      email: data.email,
      dealId: typeof userData.deal_id === "string" ? userData.deal_id : "",
      leadIds: splitIds(userData.lead_ids),
      docIds,
    },
  };
}
