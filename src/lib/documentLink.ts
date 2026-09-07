// Secure links for documents an email could not carry as attachments.
//
// ── The problem this fixes ──────────────────────────────────────────────
// The clerk email attaches every document on a file until ATTACHMENT_BUDGET_BYTES
// is spent; whatever is left over is listed as a link (see familyDocuments.ts).
// Those links were built with docDownloadHref(), which for a private blob is
// `/api/admin/documents/download?u=…` — an ADMIN route. Clicking it from an email
// returned {"success":false,"error":"Unauthorized"}, because middleware.ts gates
// everything under /api/admin on an admin session cookie and the clerk opening
// their mail has none. The one part of the email that mattered most — the
// document that did NOT arrive — was the one part that did not work.
//
// ── Why a token link, not Drive or a login ──────────────────────────────
// A link that only works for someone already signed into the admin app is not a
// delivery mechanism, and a copy on Google Drive would put client identification
// documents in a third-party store outside the firm's control (and outside the
// erase endpoint's reach). A tokenised link keeps the bytes exactly where they
// already are, in our own Blob store, and adds no new place a SIN card can live.
//
// It also grants nothing the same email did not already grant: that email is
// carrying fifteen of these documents as attachments. The link is scoped to the
// remaining few and to nothing else.
//
// ── The token ───────────────────────────────────────────────────────────
// One `invitation_tokens` row of type 'doc_link' per email, listing the exact
// blob URLs it may serve in user_data:
//
//   { kind: 'doc_link', deal_id, docs: '[{"u":"https://…","n":"26S-0527 - ID.jpeg"}]' }
//
// Scoped BY URL rather than by row id because these documents come from five
// different stores (lead_corporate_docs, lead_identification_docs,
// task_responses, tasks.document_url, deal_documents) and three of those have no
// stable id to point at. The URL list IS the authorisation, and the route serves
// by INDEX into it, so nothing a recipient can type reaches another file.
//
// Like the final report link (finalReportLink.ts) it deliberately avoids
// consumeInvitationToken() — no consumption cap, since mail scanners spend uses
// — and /api/auth/activate refuses every type but invite/recovery, so a
// forwarded document link can never be spent for a session.

import { createInvitationToken } from "./invitationToken";
import supabaseAdmin from "./supabaseAdmin";
import { logger } from "./logger";

/** `invitation_tokens.type` for an emailed document link. */
export const DOCUMENT_LINK_TOKEN_TYPE = "doc_link";

/** The public route that serves it. Outside /api/admin, so no session is needed. */
export const DOCUMENT_LINK_PATH = "/api/document-link/download";

/**
 * How long the link keeps working.
 *
 * 90 days: a clerk works a file from intake to closing and comes back to this
 * email throughout, which is far longer than an auth link's 7 days — but this is
 * a working document rather than the client's permanent record, so it does not
 * need the final report link's 180. The documents never move; a lapsed link is
 * re-sent by re-sending the email.
 */
export const DOCUMENT_LINK_TTL_DAYS = 90;

export interface LinkedDocumentRef {
  /** Blob URL, public or private. */
  url: string;
  /** Filename the recipient sees. */
  name: string;
}

export type DocumentLinkTokenResult =
  | { ok: true; scope: { dealId: string; email: string; docs: LinkedDocumentRef[] } }
  | { ok: false; reason: "missing" | "expired" | "error" };

/** Parse the docs list back out of user_data, tolerating anything malformed. */
function parseDocs(raw: unknown): LinkedDocumentRef[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const row = entry as Record<string, unknown>;
        return {
          url: typeof row?.u === "string" ? row.u : "",
          name: typeof row?.n === "string" ? row.n : "",
        };
      })
      .filter((d) => Boolean(d.url));
  } catch {
    return [];
  }
}

/**
 * Mint ONE link covering every document an email could not attach.
 *
 * One token per email rather than one per document: the row count stays sane,
 * and every item in the email's list is the same token with a different index.
 */
export async function createDocumentLink(opts: {
  /** Anchor recipient, recorded on the token row for audit. */
  email: string;
  dealId: string;
  docs: LinkedDocumentRef[];
}): Promise<{ token: string; url: string } | null> {
  const docs = opts.docs.filter((d) => d.url);
  if (docs.length === 0) return null;

  try {
    return await createInvitationToken({
      type: DOCUMENT_LINK_TOKEN_TYPE,
      email: opts.email,
      redirectTo: DOCUMENT_LINK_PATH,
      userData: {
        kind: DOCUMENT_LINK_TOKEN_TYPE,
        deal_id: opts.dealId,
        docs: JSON.stringify(docs.map((d) => ({ u: d.url, n: d.name }))),
      },
      activatePath: DOCUMENT_LINK_PATH,
      ttlDays: DOCUMENT_LINK_TTL_DAYS,
    });
  } catch (err) {
    // NEVER fail the send over this. The commonest cause is the
    // invitation_tokens type CHECK not yet widened for 'doc_link' (the
    // migration is applied by hand), and an email that arrives with 15
    // attachments and one stale link beats no email at all — the caller keeps
    // the old admin-proxy href when this returns null.
    logger.error("[DocumentLink] could not mint a link:", err);
    return null;
  }
}

/** Validate a document link token and return what it may open. */
export async function verifyDocumentLinkToken(
  token: string,
): Promise<DocumentLinkTokenResult> {
  if (!token) return { ok: false, reason: "missing" };

  const { data, error } = await supabaseAdmin
    .from("invitation_tokens")
    .select("type, email, user_data, expires_at, consumption_count")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    logger.error("[DocumentLink] token read failed:", error.message);
    return { ok: false, reason: "error" };
  }
  // A token of any OTHER type must not open documents, the same way a document
  // token must not mint an auth session.
  if (!data || data.type !== DOCUMENT_LINK_TOKEN_TYPE) {
    return { ok: false, reason: "missing" };
  }
  if (new Date(data.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const userData = (data.user_data ?? {}) as Record<string, unknown>;
  const docs = parseDocs(userData.docs);
  if (docs.length === 0) return { ok: false, reason: "missing" };

  // Best effort, never blocking: count the open and stamp the first one, so
  // staff can see whether the clerk ever fetched the document.
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
        logger.warn("[DocumentLink] could not stamp the open:", stampErr.message);
      }
    });

  return {
    ok: true,
    scope: {
      dealId: typeof userData.deal_id === "string" ? userData.deal_id : "",
      email: data.email,
      docs,
    },
  };
}
